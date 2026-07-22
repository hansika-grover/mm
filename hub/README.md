# fbacc hub — dashboard (Piece B)

Self-hosted hub that ingests the `asset-dump.json` produced by `extractor.js`, stores
every asset (profiles, BMs, ad accounts, pages, pixels, people/access) in a database
keyed on **FB global IDs**, and shows it as a **tree + reverse lookup**.

This is Step 1–2 of the build plan: single-profile READ engine + hub/schema/`/ingest`.
Access is modeled as **edges** (not flat rows), so the reverse lookup and multi-profile
dedup work the moment a second profile is ingested — no schema change needed.

## Run it

Requires **Node ≥ 22** (uses the built-in `node:sqlite` + `node:http` — **zero npm installs**).

```bash
cd hub
node server.js
# → http://127.0.0.1:5051
```

> **WSL gotcha:** WSL has its own Node, often an old one (`Cannot find module 'node:http'`
> = Node < 22). Either run with your **Windows** Node v24 from PowerShell (`cd hub; node
> server.js`), or upgrade WSL Node with `nvm install 22 && nvm use 22`. The server prints a
> clear message and exits if the Node version is too old.

Then open the URL. Under **Load data**, drag in one or more `asset-dump.json` files
(or use the samples in `hub/samples/`). Re-loading the same profile updates it in place.

## How data gets in

- **Manual:** drag-and-drop `asset-dump.json` in the dashboard.
- **From an agent / curl:**
  ```bash
  curl -X POST http://127.0.0.1:5051/api/ingest \
       -H "Content-Type: application/json" \
       --data-binary @asset-dump.json
  ```
  Batch many profiles in one call: send a JSON array, or `{"dumps":[…]}`.
  Tag the source with a `sourceLabel` field (e.g. `"MachineA/adspower-p1"`) — this is
  where the distributed AdsPower agent (Step 3) will POST per profile.

## What the dashboard shows

- **Overview** — counts across all profiles, ad-account status breakdown, per-profile
  freshness (🟢/🟡/🔴 from `fetchedAt`), and an ingest audit log (with FB warning counts).
- **Tree** — Profile → Business Manager → ad accounts · pages · pixels · people. Every
  asset shows status/spend/role and is clickable.
- **Reverse lookup** — pick any asset → the BM(s) it lives in **and every profile that can
  reach it** (with a warning when access is shared across profiles). Works for ad accounts,
  pages, pixels, people, BMs, and profiles.
- **Search** (top bar) — fuzzy match across every asset type.

## Layout

```
hub/
  server.js            # dependency-free HTTP server + API + static serving
  db.js                # SQLite schema (nodes + edges) + ingest/query logic
  public/              # dashboard (index.html, app.js, styles.css) — vanilla JS, no build
  samples/             # two example dumps (share a BM + an ad account, to demo dedup)
  data/hub.db          # created on first run (SQLite, WAL)
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | ingest one dump / array / `{dumps:[…]}` |
| GET  | `/api/summary` | counts, ad-status, profiles, sweeps, **sessions**, **recent changes** |
| GET  | `/api/tree` | full Profile → BM → assets tree (+ pixels-on-account, + profile-direct assets) |
| GET  | `/api/list?type=` | flat browsable list of one asset type |
| GET  | `/api/lookup?type=&id=` | reverse lookup — all BMs + profiles it's shared into (+ pixels↔accounts, profile-direct) |
| GET  | `/api/search?q=` | search across all asset types |
| GET  | `/api/changes?limit=&type=&id=` | change log (status flips, new assets, new access…) |
| GET  | `/api/sessions` | per-browser-session login status |
| POST | `/api/session-status` | extension reports login status (logged out / dead session) |
| POST | `/api/reset` | wipe the database |

### Multi-profile, sharing & change model
- **Assets are nodes keyed on FB global IDs; access/ownership/sharing are edges** — so the same
  ad account, page or pixel shared across many BMs *and* many profiles is stored once and its
  reverse lookup lists every BM and profile that reaches it.
- **Profile-direct assets:** accounts/pages the profile can reach that aren't in any BM (from
  `me_ad_accounts`/`me_pages`) are edged `profile→asset (direct)` and shown under the profile.
- **Pixel↔ad-account:** a pixel's `shared_accounts` become `pixel→ad_account (shared)` edges, so
  a pixel shows the accounts it's on and an account shows its pixels.
- **Changes:** each sync diffs against stored state (after the profile's first baseline sync) and
  logs status flips (incl. disabled), new assets, new access grants, and spend-limit changes.
- **Sessions:** the extension reports login status per source label; a logged-out session is
  flagged in the dashboard instead of silently showing stale data.

`type` ∈ `business · ad_account · page · pixel · person · profile`.

## Notes / next steps (per build plan)

- **DB choice:** SQLite now for zero-setup. The schema (nodes + `edges`, all keyed on FB
  global IDs) ports to **Postgres** 1:1 when moving to the shared hub (Step 4).
- Money fields (`balance`, `amount_spent`, `spend_cap`/`adtrust_dsl`) are FB **minor units**
  (cents) — formatted with the account currency in the UI.
- List fields that come back as `{error:"…"}` from Graph are tolerated and surfaced as
  per-sweep warnings rather than failing the ingest.
- Read-only. No writes to Facebook — the write/command queue is Step 5.
- Bind is `127.0.0.1` by default (`HOST`/`PORT` env to change). Keep it localhost; tokens
  never touch this hub — only extracted asset data does.
```
