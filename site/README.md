# Mailyard landing page

`public/` is the landing page served at https://mailyard.flareyard.dev: static files on an assets-only Worker (`site/wrangler.jsonc`), so serving it runs no code. Its source is the OpenDesign project `b4f0247d-d322-422f-9520-9f70a7350ee8` (`site/`). Treat these files as design output: change them there and copy them over, or edit them here and say so in the PR.

- `bun run site:deploy` deploys it. The custom domain is set on the founder's account, not in the config.
- `bun run site:audit` runs the responsive audit against a local copy. Serve `public/` first, for example `python3 -m http.server 4401` inside it, or set `SITE_BASE`.
- Links: "Sign in" goes to the founder's Mailyard (mail.flareyard.dev) and "Deploy" goes to app.flareyard.dev/apps. A fork that deploys its own landing page changes both in `public/index.html`.
