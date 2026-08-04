# MetaManager — developer handover

Everything you need to take this project over: what it is, how it works, how to run and deploy it,
what is deliberately unfinished, and — most importantly — **the approaches that were tried and
failed, and what replaced them**, so you don't re-walk those paths.

- Repo: `github.com/hansika-grover/mm` (branch `main`)
- Local directory: `Downloads/fbacc.io` (historical name; project renamed to MetaManager in `b9e1372`)
- Current HEAD at handover: `86c1728` — "In-extension dashboard viewer (no hub needed) + extraction/UX hardening"
- Node ≥ 22 required. No build step anywhere in the project.

---

## 1. What the product is

A team runs many Facebook logins — each one in its own AdsPower anti-detect browser profile, spread
across several machines and people. Every login owns or can reach some set of Business Managers, ad
accounts, pages, pixels, and people with access. Today, answering "which profile can reach ad
account X?" or "which accounts got disabled overnight?" means opening each profile by hand.

MetaManager makes one dashboard out of all of it:

- a **browser extension** that, from any logged-in Facebook tab, reads that profile's whole asset
  tree in one pass and sends it to the hub;
- a **hub** (Node server + database) that merges every profile's data into one deduplicated graph
  and diffs each sync against the last;
- a **dashboard** with an overview, a profile → BM → asset tree, flat lists, search, a change feed,
  a login-status panel, and — the headline feature — **reverse lookup**: pick any asset and see
  every BM it lives in and every profile that can reach it.

It is modeled on the third-party tool **fbacc.io**, with the phone-home removed: data goes to our
hub, and the session token never leaves the browser.

## 2. How data is fetched — the core mechanism

The extension does not scrape the UI and does not use a registered Facebook app. It **borrows the
session you are already logged into**, which is exactly what fbacc.io does (confirmed by
line-by-line analysis of its deobfuscated v6.3 source — see `metamanager-research-report.md` §2).

1. `extension/src/inject.js` runs in the page's **MAIN world**, so it can read the Facebook web
   app's own internals: `require("DTSGInitialData").token` for `fb_dtsg`,
   `require("CurrentUserInitialData")` for the user id, and a regex over the page HTML for the
   `EAAB…` access token the app already holds. The page hydrates asynchronously, so it retries on a
   700 ms interval up to 12 times.
2. `extension/src/content.js` runs **ISOLATED**, caches what inject found, and can also scrape the
   token and the `c_user` cookie itself as a fallback. `c_user` is not HttpOnly, and its presence is
   what distinguishes *"logged in, token hasn't loaded yet"* from *"actually logged out"*.
3. `extension/src/background.js` takes that token and calls `graph.facebook.com` read endpoints
   **proactively** — `/me`, `/me/businesses`, then per BM: `owned_ad_accounts`, `client_ad_accounts`,
   `owned_pages`, `client_pages`, `adspixels`, `business_users`, `pending_users`, `extendedcredits`,
   `system_users`, `instagram_accounts`; plus `/me/adaccounts` and `/me/accounts`. It follows
   pagination (`paging.next`, guard 40 pages), enriches each pixel with its `shared_accounts`, and
   runs a bounded-concurrency per-account deep pass for permission-sensitive fields.
4. The assembled dump is stored in `chrome.storage.local` (keyed by profile id) and POSTed to
   `/api/ingest`.

Because the extension issues the queries itself, **one click pulls the whole tree from any Facebook
tab** — no browsing to each Business Settings page.

**No Facebook developer app, no System User, no OAuth, no app review.** The token authenticates only
to Facebook and is never transmitted to the hub.

## 3. Repository map

```
CLAUDE.md                     working context / conventions for AI + dev sessions
HANDOVER.md                   this document
README.md                     user-facing overview and setup
DEPLOY.md                     Render + Neon free-tier deployment
PROJECT-CONTEXT.md            why it's built this way, build order, test coverage
metamanager-research-report.md  verified research on the real fbacc.io + capability matrix
metamanager-build-plan.md     locked decisions, build steps 0–5
metamanager-rebuild-NOTES.md  original vision notes
metamanager-one-pager.md      plain-English explainer for non-engineers
metamanager-HANDOFF.md        HISTORICAL — the pre-build handoff, superseded by this file

package.json                  start/test scripts; `pg` is the only runtime dependency
render.yaml                   Render blueprint (free web service)
.env.example                  template for running the local hub against the cloud DB
start-hub.bat                 Windows one-click local hub (reads .env, npm installs if needed)
extractor.js                  the original console script — reference only, not wired to anything

extension/
  manifest.json               MV3: permissions, host permissions, both content scripts
  src/inject.js               MAIN world session harvester
  src/content.js              ISOLATED bridge + DOM/cookie fallback
  src/background.js           THE ENGINE — graph walk, progress, auto-run, hub POST   (288 lines)
  popup/                      session status, Extract button, live progress bar, View all data
  options/                    hub URL, source label, autoSend, autoRun + interval, deepScan
  viewer/                     the dashboard running offline inside the extension
    store.js                  in-browser reimplementation of the hub's node+edge model (309 lines)
    app.js styles.css viewer.html

hub/
  server.js                   HTTP server, API routes, static serving, .env loader   (161 lines)
  db.js                       dual-backend driver, schema, ingest, diffing, queries  (699 lines)
  public/                     the hosted dashboard — index.html, app.js (655), styles.css
  samples/                    three synthetic dumps (two profiles sharing assets + a rich one)
  data/hub.db                 created on first local run (gitignored)

pgtest.js                     full ingest/query suite against embedded Postgres (pglite)
richtest.js                   rich-field round-trip (tax id, funding, credit, IG, system users)
```

## 4. Data model — nodes and edges

This is the single most important design decision. **Assets are nodes keyed on their Facebook global
id; ownership, access, and sharing are edges.**

Node tables: `profiles`, `businesses`, `ad_accounts`, `pages`, `pixels`, `people`.
Each carries a few queryable columns plus a `raw` JSON column holding the complete Facebook object,
so no field is lost just because there's no dedicated column. Upserts `COALESCE` so a partial write
never wipes `raw`.

One `edges` table, primary key `(src_type, src_id, dst_type, dst_id, relation)`:

| Edge | Meaning |
|---|---|
| `profile → business (member)` | the profile is a member of that BM |
| `profile → business (reaches)` | the profile reaches the BM through an asset, without formal membership |
| `business → ad_account/page (owns \| client)` | owned vs client relationship |
| `business → pixel (has)` | |
| `business → person (access)` | carries `role` and a `pending` flag for invites |
| `pixel → ad_account (shared)` | the pixel is installed on that account |
| `profile → asset (direct)` | a personal asset with **no** owning business |

Because an asset shared across five BMs and three profiles is one node with eight edges, dedup is
free and **reverse lookup is just walking edges in the other direction**.

Two supporting tables: `changes` (diffs between syncs) and `sessions` (per-browser login status),
plus `sweeps` (an ingest audit log with per-sweep Facebook warnings).

### Rules encoded in `ingest()` — know these before touching `hub/db.js`

- **BM linkage is authoritative from the asset.** An ad account's BM comes from its own
  `business{id,name}` field, not from the per-BM list calls (which permissions can block).
  "Direct" means *no owning business at all*. If an earlier sync filed an account as `direct` and a
  later one learns its business, the stale `direct` edge is deleted (`db.js:381`).
- **Baseline gate.** The first sync of a profile writes no changes — otherwise every asset would log
  as "added". Diffs start from the second sync (`db.js:285`).
- **Per-edge errors are tolerated.** A Graph list that returns `{error: …}` is recorded as a sweep
  warning via `errOf()` rather than failing the whole ingest.
- **Money is in Facebook minor units** (cents). The dashboard groups spend by currency; it never
  sums across currencies.

## 5. Hub API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | one dump, an array, or `{dumps:[…]}`; returns 207 on partial failure |
| GET | `/api/summary` | counts, ad status, spend, sessions, sweeps, recent changes |
| GET | `/api/tree` | profile → BM → assets, plus direct assets and pixels-on-accounts |
| GET | `/api/list?type=` | flat list of one asset type |
| GET | `/api/lookup?type=&id=` | reverse lookup — every BM and profile an asset touches |
| GET | `/api/search?q=` | search across all asset types |
| GET | `/api/changes?limit=&type=&id=` | change log |
| GET | `/api/sessions` | login status per source label |
| POST | `/api/session-status` | the extension reports logged-in/out here |
| POST | `/api/session-clear` | dismiss a session row |
| POST | `/api/reset` | **wipes the database** (unauthenticated — see §8) |

`type` ∈ `business · ad_account · page · pixel · person · profile`.
Everything else falls through to static serving of `hub/public/`, with an SPA fallback to
`index.html` and a path-traversal guard.

## 6. Running it

### Local development

```bash
node hub/server.js      # → http://127.0.0.1:5051, SQLite in hub/data/, zero setup
npm test                # pgtest.js + richtest.js against embedded Postgres (pglite)
```

No `npm install` is needed for the local SQLite run — `pg` is lazily required and only when
`DATABASE_URL` is set; `pglite` is a devDependency used by the tests.

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
Then open its **Options**, set a **Source label** (e.g. `MachineA-p1` — this is how the hub tells
your browsers apart), point **Hub URL** at `http://127.0.0.1:5051/api/ingest`, open a logged-in
Facebook tab, and hit **Extract**.

Without a Facebook session at all, load `hub/samples/*.asset-dump.json` through the dashboard's
drag-and-drop or `curl -X POST … --data-binary @hub/samples/rich.asset-dump.json`.

### Hosted (current production shape)

- **Database: Neon** free Postgres. Chosen because Render's own free Postgres is deleted after 30
  days; Neon's free tier does not expire.
- **Hub: Render** free web service, deployed from `render.yaml` (`npm install` / `npm start`,
  health check `/api/summary`). Set `DATABASE_URL` and `NODE_VERSION=22` in the dashboard.
- Live URL: `https://metamanager-hub.onrender.com`.
- The free tier sleeps after ~15 minutes idle; the first request afterwards takes ~30 s. Normal.
- The server binds `0.0.0.0` when `DATABASE_URL` is set and `127.0.0.1` otherwise, and reads
  Render's `PORT`. Nothing to configure.
- Confirm the backend in the deploy logs: `database → pg: …`.

### The AdsPower operating pattern (important)

Extensions inside AdsPower profiles could not reach the Render URL — AdsPower's per-profile proxy
blocked it (see §7.6). The working arrangement is:

1. Copy `.env.example` → `.env` and paste the Neon `DATABASE_URL` into it.
2. Run `start-hub.bat` on the operator's machine and leave the window open. The **local** hub now
   reads and writes the **cloud** database.
3. Point every AdsPower profile's extension at `http://127.0.0.1:5051/api/ingest` — localhost
   bypasses the proxy.
4. The Render dashboard and the local hub show the same data because they share the Neon database.

Also: in AdsPower, don't use *Load unpacked* per session — it isn't saved with the profile. Add the
extension once under **AdsPower ▸ Extensions** and attach it to profiles, so it loads automatically.

## 7. Approaches that were tried and did not work

This is the section worth reading twice. Each entry is a real dead end from the build, why it
failed, and what replaced it.

### 7.1 Passive capture-and-replay of Facebook's own GraphQL calls

**Tried.** The first extension build listened to Facebook's `/api/graphql/` traffic and replayed
those queries. The appeal was that it never hardcodes the query ids Facebook rotates.

**Why it failed.** You can only replay a query the UI has already fired. From an Ads Manager tab the
Business Settings queries never fire, so it reported **zero businesses**. Getting real coverage
would have meant a human opening every settings page in every profile — exactly the manual work the
product exists to remove.

**Solution.** Pivot to the **proactive token walk**: read the page's `EAAB…` token and call the
Graph read endpoints ourselves. This is what fbacc.io actually does, and it works from any tab in a
single click. It is now the only engine (`extension/src/background.js`).

### 7.2 The console script / bookmarklet as the product

**Tried.** `extractor.js` — paste into the console of a logged-in tab, get `asset-dump.json`.

**Why it wasn't enough.** It proved the mechanism, but it's manual per profile, downloads a file you
then have to move by hand, has no pagination, no progress, no auto-run, and no multi-profile story.

**Solution.** Move the same logic into an MV3 extension and extend it with pagination, richer field
sets, progress events, auto-run, and a direct POST to the hub. `extractor.js` is kept **only** as a
reference for the minimal mechanism — nothing depends on it.

### 7.3 Postgres from day one

**Tried.** The original build plan specified Postgres.

**Why it failed.** It put an install-and-configure step in front of every local run, for a tool that
had not yet proved its data was correct.

**Solution.** Node's built-in `node:sqlite` for local dev, with the schema designed to port 1:1.
When hosting arrived, `hub/db.js` was rewritten as an **async dual-backend layer**: SQLite locally,
Postgres when `DATABASE_URL` is set, same query logic behind a small driver shim.

### 7.4 SQLite in production, and Render's free Postgres

**Tried.** Deploying as-is with SQLite; then reaching for Render's own free Postgres.

**Why they failed.** Render's filesystem is ephemeral — the SQLite file does not survive a restart
or redeploy. And Render's free Postgres instance is **deleted after 30 days**, which is silent data
loss on a schedule.

**Solution.** **Neon**'s free Postgres (does not expire) supplied via `DATABASE_URL`, with Render
running only the stateless web service. `render.yaml` deliberately does not provision a database.

### 7.5 Cross-backend SQL that "should just work"

**Tried.** Running the SQLite SQL unchanged against Postgres.

**Why it failed.** Three concrete breakages: positional `?` placeholders (Postgres wants `$1…$n`);
`INTEGER PRIMARY KEY AUTOINCREMENT` (Postgres wants `BIGSERIAL PRIMARY KEY`); and `COUNT(*)` coming
back as a **string** from `pg`, which quietly turned counts into string concatenation.

**Solution.** A driver shim in `db.js`: `toPg()` rewrites placeholders, `driver.autoPk` supplies the
right primary-key clause, and `num()` coerces counts. Both paths are covered by `npm test`, which
runs the real `db.js` against **embedded Postgres (pglite)** — no server, no Docker.

### 7.6 The extension POSTing to the hosted hub — "Failed to fetch"

This one had four distinct causes, discovered in sequence. All four fixes are in the tree; keep them
in mind when a new deployment target misbehaves.

| # | Cause | Symptom | Fix |
|---|---|---|---|
| a | No CORS on the hub | the POST is preflighted; the browser blocked it | permissive `Access-Control-Allow-*` on every response and a `204` for `OPTIONS` (`ae17acc`) |
| b | Hub URL saved without a scheme | `fetch("host.onrender.com/api/ingest")` is treated as a **relative path** and fails silently | auto-normalize to `https://` in both `cfg()` and the options page |
| c | Host missing from `host_permissions`, or the extension not reloaded after editing the manifest | blocked before the request leaves | added `https://*.onrender.com/*`; reloading the extension after manifest edits is now documented |
| d | **AdsPower's per-profile proxy blocked the Render host** | worked in plain Chrome, failed in every AdsPower profile | run the hub **locally** against the same Neon DB (`start-hub.bat` + `.env`) and point extensions at `127.0.0.1:5051` — localhost bypasses the proxy |

And the meta-problem: the original error surfaced as a bare **"Failed to fetch"**, which named
neither the URL nor the cause and cost real debugging time. `sendToHub()` now throws a message that
names the URL and lists the three likely causes, including a specific warning when the URL is still
localhost.

**The structural fix.** Rather than keep chasing network paths, the extension gained a **complete
offline dashboard** (`extension/viewer/`). Every extract is persisted to `chrome.storage.local`
keyed by profile id, and `viewer/store.js` rebuilds the same node+edge model in the browser and
answers the exact `/api/*` shapes `app.js` expects. All data is now viewable with **no reachable hub
at all**, which sidesteps the proxy/hosting problem entirely. The `unlimitedStorage` permission
exists for this.

> Maintenance consequence: `viewer/store.js` mirrors `hub/db.js`, and `viewer/app.js` mirrors
> `hub/public/app.js`. **Change the data model or a response shape and you must change both sides**,
> or the offline viewer silently diverges from the hub.

### 7.7 One big field list per ad account

**Tried.** Requesting every interesting field — including `tax_id`, billing address, and
`extended_credit_invoice_group` — in the single `owned_ad_accounts` list call.

**Why it failed.** Those fields are permission-sensitive. One account you lack permission on makes
the **entire list call** error, so a single bad account wiped every account in that BM.

**Solution.** Split it: a generous but safe field set on the list call, then a **separate per-account
deep pass** (`ACCT_DEEP_FIELDS`) run through `mapLimit(…, 4, …)` for bounded concurrency. A failure
there loses only that account's enrichment. It's behind the `deepScan` option (default on) so an
operator can throttle the extra calls.

### 7.8 Auto-run on tab load only

**Tried.** `chrome.tabs.onUpdated` → run the extract.

**Why it failed.** MV3 tears the service worker down when idle, and if no Facebook tab reloaded,
nothing ever ran again — the dashboard silently went stale.

**Solution.** A `chrome.alarms` periodic alarm (an alarm wakes a suspended worker) plus
`onStartup`/`onInstalled`, re-armed by a `chrome.storage.onChanged` listener when the interval
changes, **in addition** to the tab-load trigger. Runs are throttled per source label.

### 7.9 Auto-running from any facebook.com tab

**Tried.** Firing on any `*.facebook.com` page.

**Why it failed.** The plain feed doesn't carry the ad-manager token, so auto-run reported "not
logged in" and the dashboard filled with **false logged-out flags** for perfectly healthy profiles.

**Solution.** Two guards. Auto-run only fires on `business.facebook.com`, `/adsmanager`, or
`/latest` URLs, where the token actually exists (manual Extract still works anywhere). And a missing
token with `c_user` **present** is treated as "page hasn't finished loading" — retried three times
at 1.5 s — not as a logout. Only a missing `c_user` reports `logged_out`.

### 7.10 Accounts wrongly filed under "Direct"

**Tried.** Treating everything from `/me/adaccounts` as a profile-direct asset.

**Why it failed.** Accounts that genuinely live in a BM showed as "not in a BM", because the
profile-level list doesn't say where they belong and the per-BM lists can be permission-blocked.

**Solution.** Request `business{id,name}` on `/me/adaccounts` and treat the asset's own `business`
field as authoritative. "Direct" now means no owning business at all. A newer sync that learns an
account's business also **deletes the stale `direct` edge** an older sync left behind — that
back-fix is why the README tells upgraders to run Extract once more.

### 7.11 Diffing from the very first sync

**Tried.** Recording changes on every ingest.

**Why it failed.** The first sync of a profile logged every single asset as "added", burying the
change feed in hundreds of useless rows.

**Solution.** A baseline gate: changes are only written if a row for that profile already exists.

### 7.12 Summing spend across accounts

**Tried.** One headline "total spend" tile.

**Why it failed.** Accounts are in different currencies. Adding USD to INR to EUR produces a number
that means nothing.

**Solution.** Spend is grouped **by currency** everywhere, and the money helpers format from Facebook
minor units with the account's own currency.

### 7.13 The AdsPower fleet agent (blocked, not abandoned)

**Planned.** A per-machine agent driving AdsPower's Local API (`127.0.0.1:50325`) to enumerate every
profile, launch each headless via Puppeteer, inject the extractor, and sweep continuously.

**Why it stalled.** On the dev machine AdsPower was installed but the **Local API was not enabled** —
nothing listening on 50325 — so Step 0 never unblocked. The API is also localhost-only by design,
which is what forces the hub-and-spoke shape (one agent per machine, not one central script).

**Solution for now.** The extension's alarm-based auto-run keeps each open profile fresh without any
fleet automation, which was enough to ship. The agent remains on the roadmap; enabling the Local API
in AdsPower settings is the first step whenever it's picked up.

### 7.14 Things checked and deliberately not built

- **Sending the access token to the hub.** Considered during the rich-capture phase and explicitly
  rejected: a stored token means ongoing access to accounts from the server, and the hub has no auth.
  Revisit only after authentication exists.
- **Full card numbers.** Facebook never exposes the PAN (PCI) — only brand, last four, and type.
  Don't go looking; the data isn't there.
- **Running the real fbacc.io.** Research settled the token-theft question for the v6.3 snapshot (no
  exfiltration), but the live tool self-updates from an operator-controlled payload, so what you run
  tomorrow is unverifiable. It is not used, and its live bookmarklet was never decoded.
- **Write actions of any kind.** Deferred until reads are proven correct against the Facebook UI.
- **Detection evasion.** Permanently out of scope — the one hard line of the project.

## 8. Known debt and risks

**Security (audited, unfixed — the hub is currently wide open):**

- **No authentication anywhere.** Every endpoint is unauthenticated, including `POST /api/reset`,
  which wipes the database. The Render URL is unguessable but not secret — treat it like a password.
  This was a deliberate "no auth for now" decision, not an oversight, and it is the single biggest
  thing to fix before the hub holds anything sensitive.
- **CORS is `*`** — necessary for the extension's cross-origin POST as currently built, but it means
  any web page can call the API.
- **`inject.js` broadcasts the live token to the page** via `postMessage(…, '*')`, and the
  `message` handlers do no origin/source/nonce checks. Any script on the Facebook page can listen.
  Fixing this means a targeted origin and a shared nonce between inject and content.
- **No rate limiting and no security headers** on the hub.
- Dashboard output is escaped consistently through `esc()` (the earlier stored-XSS note on the
  session badge is resolved) — keep it that way; every interpolation must go through it.

**Functional / operational:**

- Three response shapes were exercised only against synthetic data and want confirmation on a live
  session: `business{id,name}` on `/me/adaccounts`, per-pixel `shared_accounts`, and auto-run
  timing. The hub tolerates all three being present or absent.
- `hub/db.js` and `extension/viewer/store.js` are parallel implementations that must be kept in sync.
- No migration system — the schema is `CREATE TABLE IF NOT EXISTS` only. Adding a column to an
  existing deployment needs a manual `ALTER TABLE` or a reset.
- Render's free tier sleeps; the first request after idle takes ~30 s.
- Freshness is bounded by how often a profile's browser is open with auto-run enabled.

## 9. Roadmap (in the order it was intended)

1. **Hub authentication** — the gating item for everything else. Per-person accounts with scrypt
   password hashing was the direction being considered; nothing was decided.
2. **AdsPower fleet agent** — §7.13; makes freshness independent of a human having a tab open.
3. **Spend-change alerts** with a threshold, so they're useful rather than noisy.
4. **Write actions** (share, assign, add/remove people) behind confirmations, role gates, and an
   audit log — only after reads are verified against the Facebook UI, and with the danger tier
   (mass transfer out, token export, stripping team admin) structurally impossible.
5. **Fold into the Admin CRM** once accuracy is confirmed.

## 10. Verification checklist for a new maintainer

Do these in order; each one exercises a layer without needing a Facebook session until the last.

1. `npm test` — expect all PASS on both `pgtest.js` and `richtest.js`.
2. `node hub/server.js`, open `http://127.0.0.1:5051`, and POST `hub/samples/rich.asset-dump.json`
   to `/api/ingest`. The overview should populate.
3. POST the other two samples (`profile1`, `profile2`) and confirm **dedup and reverse lookup**:
   the shared BM and shared ad account should each appear once, listing both profiles.
4. Load the extension unpacked, open a logged-in `business.facebook.com` tab, and hit **Extract**.
   Watch the progress bar; check the popup's session-token pill reads "found".
5. Click **View all data** in the popup — the offline viewer should show the same tree the hub does.
6. Re-run Extract and confirm the **change feed** stays empty for an unchanged profile (baseline gate
   working) and that a status flip does show up.

---

*Questions this document can't answer are most likely covered in `PROJECT-CONTEXT.md` (reasoning and
build order) or `metamanager-research-report.md` (what the original fbacc.io actually does, verified).*
