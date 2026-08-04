# CLAUDE.md — working context for this repo

Guidance for Claude Code (and any AI/dev session) working in `Downloads/fbacc.io`.
Read this first, then `HANDOVER.md` for the full engineering handover.

---

## What this project is

**MetaManager** — a self-hosted dashboard that centralizes every Facebook Business asset the team
owns (Business Managers → ad accounts → pages → pixels → people with access) across many Facebook
logins, each living in its own AdsPower anti-detect browser profile.

Repo: `github.com/hansika-grover/mm` · branch `main` · local dir `c:\Users\hansi\Downloads\fbacc.io`
(the directory name `fbacc.io` is historical — the project was renamed to MetaManager in `b9e1372`).

It is a rebuild of the third-party tool **fbacc.io**, changed so the data lands on our own hub
instead of someone else's server. References to fbacc.io in the docs describe that external tool
and are intentionally kept.

## The core mechanism (do not redesign this without reading below)

It **borrows the logged-in session**. There is no Facebook developer app, no System User, no OAuth,
no app review:

1. A content script reads the `EAAB…` access token the Facebook web app already put on the page.
2. The background worker calls `graph.facebook.com` **read** endpoints with that token, as the user.
3. It assembles one JSON dump and POSTs it to the hub (and stores it locally for the offline viewer).

The token is used only to talk to Facebook. It is never sent to the hub.

## Hard invariants — treat these as non-negotiable

- **Read-only.** Only GET/list endpoints against Facebook. No writes, ever, without an explicit
  new decision from the user (writes are a deliberately deferred phase-2 item).
- **The access token never leaves the browser.** Not to the hub, not to logs, not to storage
  intended for sync. Token capture into the hub was considered and deliberately rejected until the
  hub has auth (see `1f6ad8f`).
- **No detection-evasion.** Rate-limiting so legitimate bulk reads don't trip flags is fine. Anything
  whose purpose is to make Facebook blind to us is out of scope and must not be built.
- **Scope is owned assets only** — assets the org controls, reached through logins it owns.
- Never commit real Facebook data, dumps, `.env`, or DB files. `.gitignore` already covers these;
  the synthetic dumps in `hub/samples/` are the only data in the repo.

## Stack and conventions

| Area | Choice | Why |
|---|---|---|
| Hub server | Node built-in `node:http` | zero dependencies |
| Local DB | Node built-in `node:sqlite` (Node ≥ 22) | zero install |
| Hosted DB | Postgres via `pg`, when `DATABASE_URL` is set | Render/Neon persistence |
| Extension | plain MV3, no build step | loads unpacked anywhere |
| Dashboard | vanilla JS SPA, no framework, no bundler | no build step |

Code conventions actually used in this repo — match them:

- `'use strict';` at the top of every file. CommonJS (`require`) on the hub side.
- Dense, purposeful comments that explain **why**, especially where a non-obvious decision was
  forced by a bug. Several such comments are the only record of a fix — don't strip them.
- Small helper arrows (`arr`, `asList`, `esc`, `num`) rather than utility modules.
- Every string interpolated into dashboard HTML goes through `esc()`. No exceptions.
- Money from Facebook is in **minor units** (cents). Never sum spend across currencies — group by it.

## Layout

```
extension/          MV3 extension
  src/inject.js       MAIN world — harvests token / fb_dtsg / user id off the page
  src/content.js      ISOLATED world — bridge + DOM/cookie fallback (c_user = logged in)
  src/background.js   THE ENGINE — graph walk, pagination, progress, auto-run, hub POST
  popup/ options/     UI: extract button + live progress; hub URL, source label, toggles
  viewer/             the dashboard, running fully offline inside the extension
    store.js            in-browser reimplementation of hub/db.js's node+edge model
hub/
  server.js           HTTP + API + static serving + .env loader
  db.js               dual-backend DB, schema, ingest, change detection, all queries
  public/             the hosted dashboard (index.html, app.js, styles.css)
  samples/            synthetic dumps for testing without a Facebook session
extractor.js        the original one-file console script (reference only)
pgtest.js richtest.js  the test suite (`npm test`) — runs against embedded pglite
```

**`extension/viewer/store.js` mirrors `hub/db.js` and `extension/viewer/app.js` mirrors
`hub/public/app.js`.** They are deliberate near-duplicates so the dashboard works with no hub.
If you change the data model or a `/api/*` response shape, change **both sides** or the offline
viewer silently diverges.

## Running and testing

```bash
node hub/server.js          # → http://127.0.0.1:5051   (SQLite, zero setup)
npm test                    # pgtest.js + richtest.js against embedded Postgres (pglite)
start-hub.bat               # Windows: hub against the cloud DB, reading .env
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`.

## Environment gotchas (these have all bitten before)

- **Node ≥ 22 required** for `node:sqlite`. WSL's Node is often older — use the Windows Node.
  `db.js` version-checks and prints a clear message.
- **Stale hub process** holds port 5051 and the SQLite lock, so deletes fail with "Device or
  resource busy" and curls hit old code. Kill it: `Get-NetTCPConnection -LocalPort 5051` →
  `Stop-Process`.
- **Hard-refresh the dashboard** (Ctrl+Shift+R) after editing `app.js`/`styles.css` — it's a static
  SPA and the browser caches it.
- **Reload the extension** in `chrome://extensions` after editing anything under `extension/`,
  especially `manifest.json` (host permissions are read at load).
- **`git push` in PowerShell** prints a NativeCommandError and sets `$?` false even on success —
  git writes progress to stderr. Trust the `a..b main -> main` line, not the exit status.

## Current state

All five build steps are done and committed: extractor → hub/dashboard → extension → multi-profile
with change detection and sessions → Postgres-ready deploy → rich fields → offline in-extension
viewer. Working tree is clean at `86c1728`.

**Deliberately not built yet:** any Facebook write action, hub authentication, and the AdsPower
fleet agent. See `HANDOVER.md` §"Known debt" and §"Roadmap" before starting any of them.

**Open security debt** (audited, not fixed — do not treat the hub as safe):
the hub has **no auth at all** and `POST /api/reset` wipes the database; CORS is `*`; there is no
rate limiting and no security headers; `inject.js` broadcasts the live token to the page via
`postMessage(…, '*')` and the handlers do no origin/source checks.

## Where the reasoning lives

| Document | Contents |
|---|---|
| `HANDOVER.md` | **the developer handover** — architecture, ops runbook, failed approaches + fixes |
| `PROJECT-CONTEXT.md` | why it's built this way, build order, what's tested |
| `README.md` | user-facing: what it does, how to run it |
| `DEPLOY.md` | Render + Neon free-tier deployment walkthrough |
| `metamanager-research-report.md` | verified research on the real fbacc.io + capability matrix |
| `metamanager-build-plan.md` | locked decisions and the original build steps 0–5 |
| `metamanager-rebuild-NOTES.md` | the original vision notes |
| `metamanager-HANDOFF.md` | **historical** — the pre-build handoff, superseded by `HANDOVER.md` |
