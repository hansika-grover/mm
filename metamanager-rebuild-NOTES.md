# fbacc.io Rebuild — Working Notes

> Goal: recreate fbacc.io (FB asset extractor + sharer) for our org — self-hosted,
> token-safe, feeding a single live dashboard across many AdsPower installs/profiles.

---

## 1. What fbacc.io is

A **self-extracting bookmarklet**. Structure:

```
javascript:
  var LZString = {...}            // decompression lib
  var compressed = `BQMw...`      // the ENTIRE tool, LZString-compressed (~40KB+)
  <eval line>                     // unzips compressed -> live JS -> runs in your FB tab
```

Click it while logged into Facebook → it unzips into JS and runs **inside your FB tab, as you.**
Compression is to (a) fit a bookmark and (b) hide what it does.

---

## 2. How it actually works (mechanism)

It doesn't hack FB — it **borrows your session**:

1. Reads from the page: **cookies** (your login), **`fb_dtsg`** (anti-CSRF token),
   **access token** (`EAAB...` that FB's own web app uses).
2. Calls **Facebook's own internal Graph/GraphQL APIs as you** — no password, no popup.
3. Walks the asset tree:
   - `/me` → user
   - `/me/businesses` → every BM (id, name, role, verification)
   - `/{bm}/owned_ad_accounts` + `/client_ad_accounts` → ad accounts (act_id, name,
     currency, spend cap, spent, status, funding)
   - `/{bm}/owned_pages` + `/client_pages` → pages
   - `/{bm}/adspixels` → pixels
   - `/{bm}/business_users` + `/pending_users` → **who has access** (the "connectivity")
4. Packages to JSON, shows on-screen, and **POSTs to fbacc.io's server.**

**The one sensitive question:** does it send only asset data, or also your **access token**?
A token = ongoing access to your accounts from their server, without you. (Confirm via decode.)

---

## 3. Capability ladder — what it CAN / CAN'T do

Core principle: it runs **as you**, so its ceiling = **anything you can do in the FB UI**,
but automated, instant, and in bulk.

**CAN:**
- **L1 Read/extract** — full asset graph, roles, spend, status *(we use this)*
- **L2 Monitor** — re-run to track spend/status/access changes over time
- **L3 Write/manage** — share/assign assets, add/remove people, create accounts,
  rename, set limits, accept invites, **bulk** *(we use BM-share = this level)*
- **L4 Danger** — mass-transfer out, **export token off-site**, strip team admin

**CAN'T:**
- Touch BMs you're **not a member of**
- Change **password / 2FA**, or take the **identity** itself
- Beat FB **rate limits / fraud detection** on fast bulk writes
- (Usually) transfer **ownership** of an ad account between BMs — FB restricts this;
  pages/pixels move freely, ad-account *access* shares fine, *ownership* is sticky

---

## 4. Confirmed functions (what we know it does)

1. **Extract all assets of a profile** — BMs, ad accounts, pages, pixels.
2. **Share a BM to another profile via invite link:**
   - Click Share on a BM → enter target profile's **email** → tool generates an **invite link**
   - This calls FB's BM-invite API (BM id + email + role) → FB returns a token-bearing link
   - Open link in the 2nd profile's browser → accept → BM now attached to profile 2
   - NOTE: the link is a **bearer credential** — anyone who opens it logged-in can claim it.
   - => Proves the tool does **writes**, not just reads.

---

## 5. Multiple profiles / AdsPower reality

- The tool is **per-session** — sees only the ONE profile whose tab it runs in.
- Each profile = a separate login = a separate **AdsPower anti-detect browser**
  (our CRM's AdsPower ID / Multi-login ID = these isolated browsers).
- So: one click per profile. That's why BM-share needs 2 browsers (profile 1 generates,
  profile 2 accepts) — two separate sessions.

**Our scale:** MANY AdsPower installs (across machines/team), each with MANY profiles.

---

## 6. Proposed architecture — distributed agents → central hub

AdsPower's **Local API** (`http://local.adspower.net:50325`, localhost-only) is the key:
- `GET /api/v1/user/list` → enumerate all profiles on that install
- `GET /api/v1/browser/start?user_id=X` → launch profile, returns Puppeteer/CDP debug endpoint
- `GET /api/v1/browser/stop?user_id=X` → close

Because the API is localhost-only, ONE central script can't reach all installs.
=> **Hub-and-spoke**:

```
Machine A: AdsPower (N profiles) → Agent A ┐
Machine B: AdsPower (N profiles) → Agent B ┼→ Central Hub (cloud) → Dashboard
Machine C: AdsPower (N profiles) → Agent C ┘   (DB · dedup · diff · push)
```

**Each Agent (small installable runner per AdsPower machine):**
1. Self-registers with hub (agentId = machine/team member)
2. `user/list` → enumerate its profiles
3. Rolling sweep, batched 3–5 at a time, **headless**:
   - start profile → `puppeteer.connect({ browserWSEndpoint })`
   - go to business.facebook.com (session already live)
   - inject extractor (same logic as bookmarklet) → collect JSON
   - POST to hub tagged `agentId + profileId`
   - stop profile → next
4. Heartbeat so hub knows machine is alive

More machines = more throughput (they sweep **in parallel**). Centralize only the DATA,
never the browsing. **Runner must live on the same machine as AdsPower** (localhost API);
hub/dashboard can be cloud.

---

## 7. Live feed / anti-stale design

FB doesn't push → "live" = **continuous rolling polling + instant propagation**:

- **Rolling sweep, not batch-and-wait** — cycle profiles endlessly so each re-reads every X min.
- **Prioritized cadence** — hot/active accounts ~15 min; cold ones hourly.
- **Push to dashboard** via websocket/SSE — UI updates the moment an agent reports.
- **Freshness stamps** per record: 🟢 fresh / 🟡 aging / 🔴 stale + `lastSyncedAt`.
- **Session-dead detection** — logged-out profile flagged "needs re-login", not shown stale.
- **Diff every sweep** → disabled account / new admin / access removed / spend-cap change → alert.

**Freshness ceiling** = FB rate limits + machine resources. Realistic: each profile refreshed
every **15 min – few hours**, rolling, dashboard always showing how fresh each row is.

---

## 8. Full functionality catalog

### 🧩 Extension / Agent (in-browser, per profile)
**Read:** full asset dump; access map (who has what); per-account status/spend/cap/currency/
funding/payment/balance; profile info/2FA/verification/pending; token+cookie (in-memory only).
**Write:** share BM/ad-account/page/pixel → profile or BM; add/remove people + roles;
add partner BM; auto-accept invites; create ad-account/BM/page/pixel; rename/timezone/spend-limit;
request access; **bulk** any of these.
**Automation:** session-health check; rolling scheduled sweeps; retry / flag needs-re-login.

### 📊 Dashboard / Hub (central)
**Visibility:** unified graph across all machines+profiles, tree profile→BM→acct→page→pixel;
search/filter/facets (profile, agent, BM, status, spend); freshness stamps; agent/machine
health + dead-profile flags.
**Monitoring:** change detection + diff history; alerts (plug into existing alert engine);
spend-over-time; status timeline.
**Remote management (dashboard → agent executes):** trigger share/assign remotely; bulk
share/assign across profiles; **invite-link registry** (log + who it went to, kept internal);
request/approval queue.
**Records/reporting:** audit log (who/what/when/which agent); export CSV/JSON; ownership+
relationship map; spend/ROI reporting (ties to Agency Spend); assign profiles → team/TLs.
**CRM integration:** write into existing hierarchy models; reconcile against current records.

### ⚠️ Deliberately excluded (danger tier)
Mass asset-transfer out; token export off-machine; stripping team admin.
Rebuild should be *incapable* of these — confirmations + role-gates on every write.

---

## 9. Improvements over fbacc.io

1. **Kill the phone-home** — data → our system, not fbacc's server.
2. **Never store the token** — use in-memory, discard.
3. **Write straight into existing CRM models** — no CSV/copy-paste.
4. **Multi-profile aggregation** — all AdsPower profiles → one dashboard.
5. **Change detection + alerts** — snapshot tool → live monitor.
6. **Invite links kept internal** — no bearer links floating in Slack.
7. **Guardrails on writes** — confirmations + role checks; danger tier impossible.
8. **Rate-limit awareness** on bulk ops so FB doesn't flag profiles.

---

## 10. Open items / next steps

- [ ] **DECODE the real bookmarklet** — save full `javascript:…` to `~/Desktop/fbacc-full.txt`,
      run `node <scratchpad>/decompress.js ~/Desktop/fbacc-full.txt`. Confirms:
      exact endpoints, exact features present, and **whether it exports the token to fbacc.io**.
- [ ] Decide dashboard target: standalone vs inside existing CRM.
- [ ] Define **Agent ↔ Hub contract** (register, push, heartbeat, command endpoints + data shape).
- [ ] Phased build plan: (1) single-profile extractor, (2) one agent full-sweep,
      (3) hub + dashboard, (4) live feed + diffs, (5) remote write actions.

---

*Decompressor already built at:*
`<scratchpad>/decompress.js` (run with TOLERATE_TRUNCATION=1 to read a cut-off blob).
