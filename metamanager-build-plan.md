# MetaManager — Build Plan & Decisions

> Recorded 2026-07-14. Companion to `metamanager-rebuild-NOTES.md` + `metamanager-research-report.md`.

## Locked decisions
- **Target:** standalone hub + dashboard; integrate into the Admin CRM *only once it's proven 100% accurate.*
- **Engine choice:** maximal-capability **session-inject** path (scraped token, headless per profile) as the
  always-available layer — reaches 100% of FB UI operations, no Meta app review. Official API used where it reaches.
- **Stack (provisional):** Node/TypeScript + Puppeteer (agent), Postgres (hub), React (dashboard).
- **First build:** the do-everything engine, single profile, READ first.

## Scope confirmed (2026-07-14)
- **All assets in scope are owned/controlled by the org** (user-confirmed). So "operating on accounts
  you don't own" is moot — the tool only ever reaches what the org's own logins can see.

## Allowed (user's engineering/risk choices — will build)
- Centralize/store tokens on the org's own hub → allowed. Mitigation: keep scraped session token
  in-memory where possible; store only long-lived tokens, encrypted at rest. Blast-radius warning noted.
- Send data to the org's own hub (not a third party) → this is just the dashboard.
- Bulk transfer / remove admins / share assets **on owned assets** → allowed, with confirm + audit.
- Generate/route invite links as needed → allowed (internal registry + auto-consume recommended, not required).

## The one hard line (stands regardless)
- **No detection-evasion whose purpose is to defeat FB fraud/enforcement.** Rate-limiting so legit bulk
  ops don't trip flags = fine and included. "Make FB blind to us so we can do what they'd ban" = not built.
  (Not needed for a legit owned-asset operation.)

## Why READ first
Read is the foundation: dedup, dashboard, and safe writes all depend on a provably-correct read.
The "100% accurate before CRM" bar = the read being exact. Build read → verify vs FB UI → then writes.

## Build sequence
- **Step 0 — Prove the pipe:** AdsPower Local API → `user/list` → `browser/start` (CDP) → Puppeteer connect →
  load business.facebook.com in live session. No writes.
- **Step 1 — Single-profile READ engine:** inject extractor → full asset tree JSON → verify cell-by-cell vs UI.
- **Step 2 — Hub + schema + push:** Postgres graph (keyed on FB global IDs) + `/ingest`.
- **Step 3 — Agent + fleet sweep:** installable agent, rolling sweep over ALL profiles on one install (solves multi-profile).
- **Step 4 — Second machine + dedup:** deploy agent to another install; hub dedups + builds unified graph (solves multi-AdsPower).
- **Step 5 — Writes:** command queue dashboard → hub → routed agent/profile → guarded write → report. Start with 1 safe write, expand across matrix.

## Multi-profile × multi-AdsPower solution
- **Physical:** each AdsPower Local API is localhost-only → **one agent per install**; all agents → one hub. More machines = more parallel throughput.
- **Data (crux):** same asset visible from many profiles → dedup by **FB global ID**, model **access as edges**:
  - Assets = nodes stored once (BM/act/page/pixel id).
  - `Profile → Asset, role/tasks` = edge. N profiles seeing act_123 = N edges into 1 node.
  - Gives dedup + the who-can-touch-what map + **command routing** (hub finds which profile has MANAGE → sends write there).
- **Nodes:** Agent(machine) · Profile(adspower_user_id) · FBUser · Business · AdAccount · Page · Pixel · Person. Every FB node keyed on FB ID.
- **Freshness:** rolling sweep (hot ~15m, cold hourly), per-asset `lastSyncedAt`, dead-profile flags.

## Reverse lookup / relationship search (headline feature — free from the graph)
Select any asset(s) → see where they live and what connects, traversing edges in any direction:
- Pick **ad account(s)** → its BM + every profile that can reach it (with role).
- Pick **page(s)** → its BM(s) + profiles that can reach it.
- Pick **BM(s)** → every profile it appears in (member + role).
- Pick **pixel(s)** → every ad account it's shared into (1→many share view).
- Multi-select (union + overlap detection) and reverse (profile → all its assets = normal tree).
- Answers real questions instantly: "which profiles can touch this BM?" (access audit),
  "where is this pixel shared it shouldn't be?" (cleanup), "if P9 dies, what's lost?" (risk map).
- Enabled purely because assets are keyed on FB global IDs + access stored as edges (not flat rows).

## Capability surface
Full operation × asset matrix in `metamanager-research-report.md` §3. Walls are FB's own, not the tool's:
ad-account **ownership transfer** restricted (share access only); **creation caps**; **rate limits** (ban trigger).

## Environment finding (2026-07-14)
- **AdsPower Global.app IS installed** on the dev machine (`/Applications`).
- **Local API NOT running** — nothing listening on port 50325. → must open AdsPower + enable Local API to unblock Step 0.

## To start
1. Open AdsPower → Settings → enable Local API (127.0.0.1:50325 listening).
2. Real bookmarklet → `~/Desktop/fbacc-full.txt` for decode (lift exact endpoints).
3. Pick: (a) scaffold project now, (b) run verified gap research (AdsPower API specs + rate limits), (c) both.

## Open items
- Decode live bookmarklet vs clean v6.3 snapshot.
- Verified AdsPower Local API + System User + rate-limit research (errored angle).
- Set up Pith wiki (not yet done).
- Chinese/Russian competitor catalog (partial).
