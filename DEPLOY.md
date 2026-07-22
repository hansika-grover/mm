# Deploying MetaManager (free, org-wide)

MetaManager has two pieces, shipped separately:

1. **The hub** — the Node server + dashboard + database. Hosted once, on Render. Everyone opens the same URL.
2. **The extension** — installed in each operator's browser. It reads Facebook and POSTs to the hub.

Everything below uses free tiers only.

> ⚠️ **No auth yet.** The hub currently has no login. Anyone who has the URL can read all the data
> (and `POST /api/reset` wipes it). The Render URL is public and unguessable but not secret — treat it
> like a password and don't share it beyond the team. Ask to have the auth layer added before this
> holds anything you'd mind leaking.

---

## Part 1 — the database (Neon, free, permanent)

Render's own free Postgres is deleted after 30 days, so we use **Neon**, whose free tier does not expire.

1. Sign up at **https://neon.tech** (free, no card).
2. Create a project → it gives you a **connection string** like:
   `postgresql://user:pass@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`
3. Copy that whole string. That's your `DATABASE_URL`.

That's it — the hub creates all its tables automatically on first boot.

## Part 2 — the hub (Render, free)

1. Push this repo to GitHub (already done: `github.com/hansika-grover/mm`).
2. At **https://render.com** → **New ▸ Blueprint** → pick the repo. It reads `render.yaml` and creates
   a free web service. (Or **New ▸ Web Service** manually: Build `npm install`, Start `npm start`.)
3. In the service's **Environment**, set:
   - `DATABASE_URL` = the Neon string from Part 1.
   - `NODE_VERSION` = `22`.
4. Deploy. You'll get a URL like `https://metamanager-hub.onrender.com`. Open it — the dashboard loads
   (empty until the extension sends data).

Notes:
- **Free tier sleeps** after ~15 min idle; the first request afterward takes ~30 s to wake. Normal.
- The server binds `0.0.0.0` and reads Render's `PORT` automatically — nothing to configure.
- To confirm the DB is Postgres, check the deploy logs for `database → pg: …`.

## Part 3 — the extension (each operator's browser)

### Point it at the hub
1. Load the extension (see persistence below), then open its **Options**.
2. Set **Hub URL** to `https://YOUR-APP.onrender.com/api/ingest`.
3. Set **Source label** to something identifying that browser/profile (e.g. `MachineA-p1`).
4. Leave **Auto-run** on.

### Keep it installed & auto-running (the "I have to reload it every time" fix)
An unpacked extension loaded via *Load unpacked* normally survives browser restarts. If yours keeps
disappearing, it's the browser wiping it on launch. Fixes, by browser:

- **AdsPower** (most likely your case): don't use *Load unpacked* per-session — it isn't saved with the
  profile. Instead add the extension once through **AdsPower ▸ Extensions** (local extension), then attach
  it to the profiles that should have it. It then loads automatically every time that profile opens.
- **Plain Chrome/Edge:** *Load unpacked* persists across restarts. If you see a "Disable developer-mode
  extensions" popup on each launch, just close it (don't click Disable). To remove the popup entirely,
  pack the extension: `chrome://extensions` ▸ **Pack extension** ▸ select the `extension/` folder ▸ install
  the resulting `.crx`, or push it to the Chrome Web Store as a **private/unlisted** item for the team.

Auto-run is already wired to fire (a) when a Facebook Business/Ads-Manager tab finishes loading and
(b) on a repeating timer (`Auto-run every N min`, default 10) plus on browser startup — so once installed
and pointed at the hub, it keeps the dashboard fresh with no clicking, as long as a logged-in Facebook
tab is open somewhere.

---

## Running locally (development)

No database setup needed — with no `DATABASE_URL`, the hub uses Node's built-in SQLite in `hub/data/`.

```bash
node hub/server.js        # → http://127.0.0.1:5051
```

To exercise the Postgres code path without a server, `npm test` runs the full ingest/query suite against
an embedded Postgres (pglite).
