import { Context, Hono } from "hono";
import { html } from "hono/html";
import { cors } from "hono/cors";
import type { ErrorHandler } from "hono";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { sortBy, uniqBy } from "lodash";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkHtml from "remark-html";
import humanizeDuration from "humanize-duration";

type Env = Context["env"]["Bindings"] & {
  DB: D1Database;
};

interface Visit {
  ip: string;
  visited_at: number;
  visited_from_city: string | null;
  visited_from_country: string | null;
  author: string | null;
  message: string | null;
}

interface Database {
  visits: Visit;
}

const getDb = (env: Env) => {
  return new Kysely<Database>({
    dialect: new D1Dialect({ database: env.DB }),
  });
};

const upsertBasicVisit = async (
  env: Env,
  ip: string,
  city: string,
  country: string
) => {
  const db = getDb(env);

  // Find visit from within the past 10 minutes from the same IP
  const tenMinutesAgo = new Date();
  tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);

  const recentVisit = await db
    .updateTable("visits")
    .set({ visited_at: Date.now() })
    .where("ip", "=", ip)
    .where("visited_at", ">", tenMinutesAgo.getTime())
    .where("message", "is", null)
    .where("author", "is", null)
    .returning(["ip"])
    .executeTakeFirst();

  if (!recentVisit) {
    const toInsert = {
      ip,
      visited_at: Date.now(),
      visited_from_city: city,
      visited_from_country: country,
    };

    await db.insertInto("visits").values(toInsert).execute();
  }
};

const upsertVisitWithMessage = async (
  env: Env,
  ip: string,
  author: string,
  message: string,
  city: string,
  country: string
) => {
  const db = getDb(env);

  // Find visit from within the past 10 minutes from the same IP
  const tenMinutesAgo = new Date();
  tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);
  console.log(
    "🚀 ~ file: index.ts:76 ~ tenMinutesAgo:",
    tenMinutesAgo.getTime()
  );

  const recentVisit = await db
    .updateTable("visits")
    .set({ visited_at: Date.now() })
    .where("ip", "=", ip)
    .where("visited_at", ">", tenMinutesAgo.getTime())
    .where("author", "is", null)
    .where("message", "is", null)
    .returning(["ip"])
    .executeTakeFirst();

  if (recentVisit) {
    await db
      .updateTable("visits")
      .set({ author, message, visited_at: Date.now() })
      .where("ip", "=", ip)
      .where("visited_at", ">", tenMinutesAgo.getTime())
      .where("author", "is", null)
      .where("message", "is", null)
      .execute();
  } else {
    await db
      .insertInto("visits")
      .values({
        ip,
        author,
        message,
        visited_at: Date.now(),
        visited_from_city: city,
        visited_from_country: country,
      })
      .execute()
      .then(console.log);
  }
};

const renderLogAsHtml = async (env: Env) => {
  const db = getDb(env);

  // Last 24 hours visits
  const since = new Date();
  since.setHours(since.getHours() - 24);

  const last24HoursVisits = await db
    .selectFrom("visits")
    .selectAll()
    .orderBy("visited_at", "desc")
    .where("visited_at", ">", since.getTime())
    .where("author", "is not", null)
    .where("message", "is not", null)
    .execute();

  const last10Visits = await db
    .selectFrom("visits")
    .selectAll()
    .orderBy("visited_at", "desc")
    .where("author", "is not", null)
    .where("message", "is not", null)
    .limit(10)
    .execute();

  const visits = sortBy(
    uniqBy(
      [...last24HoursVisits, ...last10Visits],
      (visit) =>
        `${visit.ip}-${visit.visited_at}-${visit.message}-${visit.author}`
    ),
    (visit) => visit.visited_at
  );

  visits.reverse();

  const markdown = visits
    .map(
      (visit) =>
        `${visit.author} wrote ${humanizeDuration(
          Date.now() - visit.visited_at,
          { units: ["d", "h", "m", "s"], round: true }
        )} ago:\n ${visit.message
          ?.split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`
    )
    .join("\n\n");

  const vfile = await unified()
    .use(remarkParse as any, {})
    .use(remarkHtml as any, {})
    .process(markdown);

  return vfile.toString();
};

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => origin,
  })
);
app.options("*", (c) => {
  return c.text("", 204);
});

app.get("/view", async (c) => {
  // Note: this is cloudflare worker specific code
  //github.com/honojs/hono/issues/379
  const ip = c.req.header("x-real-ip") || "unknown";
  const country = c.req.header("cf-ipcountry") || "unknown";
  const city = c.req.header("cf-ipcity") || "unknown";

  await upsertBasicVisit(c.env, ip, city, country);

  // Respond with html
  return c.html(await renderLogAsHtml(c.env));
});

app.post("/write", async (c) => {
  // Note: this is cloudflare worker specific code
  //github.com/honojs/hono/issues/379
  const ip = c.req.header("x-real-ip") || "unknown";
  const country = c.req.header("cf-ipcountry") || "unknown";
  const city = c.req.header("cf-ipcity") || "unknown";

  const body = await c.req.parseBody();

  // Get author and message from standard form body
  if (!body.author || !body.message) {
    return c.html(html`<h1>Missing author or message</h1>`, 400);
  }

  const { author, message } = body;

  // Write to D1
  await upsertVisitWithMessage(
    c.env,
    ip,
    author as string,
    message as string,
    city,
    country
  );

  // Respond with redirect to /guestbook
  return c.redirect("https://bprp.xyz/guestbook");
});

const errorHandler: ErrorHandler = (err, c) => {
  console.log(err.message);
  return c.text("Error!", 500);
};

app.onError(errorHandler);

export default app;
