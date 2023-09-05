# Guestbook

This is a pretty simple and janky (unsecured, maybe vulnerable to XSS) implementation
of a guestbook for my personal site at https://bprp.xyz.

This is designed to run on Cloudflare Workers, and stores data in a Cloudflare D1
SQLite database.

The big challenge was getting this dynamic content to layer on top of (Obsidian Publish)[https://obsidian.md/publish]. The solution I found was throwing a div with `#guestbook` on any page I wanted
the guestbook to appear in, and then throwing the following into my `publish.js`:
```javasacript
const handler = () => {
  if (document.querySelector('#guestbook')) {
    const hasChildren = document.querySelector('#guestbook div') || document.querySelector('#guestbook p');
    if (hasChildren) return;

    const p = document.createElement("p");
    p.textContent = "Loading...";
    const div = document.createElement('div')
    div.appendChild(p)
    document.getElementById('guestbook').appendChild(div);

    fetch('https://guestbook.bprpxyz.workers.dev/view')
      .then(response => response.text())
      .then(data => {
        const guestbookDiv = document.getElementById('guestbook');
        if (guestbookDiv) {
          guestbookDiv.innerHTML = data;
        }
      })
      .catch(error => {
        console.error('There was an error fetching the data:', error);
      });	
  }
}

// Create a new observer instance
let observer = new MutationObserver(handler);

// Configuration of the observer:
let config = { attributes: true, childList: true, subtree: true };

// Start observing the document with the configured parameters
observer.observe(document, config);
```

