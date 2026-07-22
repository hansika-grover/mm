# fbacc.io — Deep Research Report & Capability Catalog

> Compiled 2026-07-14. Companion to `metamanager-rebuild-NOTES.md`.
> Method: 5-angle fan-out web research → 14 sources fetched → 64 claims extracted →
> 25 verified by 3-vote adversarial verification (23 confirmed, 2 refuted).
> Confidence tags: `[verified, N-0]` = adversarially confirmed; `[my knowledge]` = domain
> knowledge, not from this research run (flagged where the research had gaps).

---

## 0. Bottom line

- **fbacc.io = "FB Acc Status"** — a session-borrowing Facebook Business Manager tool, ~v6.3–6.4,
  distributed via the `fbacc.io` domain + Telegram **t.me/fbacctools** (legacy: a CodePen by
  user "prembm", Ver 4.4 / May 2022). Russian/CIS media-buyer product.
- **The token-theft question is answered.** Line-by-line analysis of the deobfuscated v6.3
  source shows **NO exfiltration** — token + `fb_dtsg` go ONLY to Facebook-owned domains.
  The "it steals your token to their server" fear is **not substantiated for that version.**
  BUT: the live tool is served from fbacc.io and can ship altered code; it self-updates from an
  operator-controlled Facebook object injected via `innerHTML`. So "v6.3 is clean" ≠ "fbacc.io is safe."
- **The danger tier is real** — demonstrated by a sibling tool (CL Suite) that steals People CSVs,
  BM data, and TOTP 2FA seeds to a C2. That's the category's true risk, not fbacc.io itself.
- **The compliant "better than this" path** = Meta's **Business Management API** (`contained_<asset>`
  endpoints) driven by **System User tokens** — same read/write outcomes, no borrowed session.
- **Legal:** every borrowed-session tool in this category (fbacc.io included) violates Meta Platform
  Terms *regardless of exfiltration*, because it drives internal endpoints with a scraped session.

---

## 1. What fbacc.io is  `[verified, 3-0]`

- Legacy [CodePen "prembm"](https://codepen.io/prembm/full/YzPMjaj) titled *"FB Accounts tools fbacc.io"*
  now iframes fbacc.io; states *"New versions moved to the domain: https://fbacc.io"*; points to
  **t.me/fbacctools**. In-code: *"Ver. 4.4 from 28.05.2022."*
- [Deobfuscated v6.3 source](https://gist.github.com/dvygolov/901f5ebd8ff76eeefd0f297cff57b7a3)
  identifies as `window.adsplugver = '6.3'`.
- [Marketing blog (teletype.in/@finikoff)](https://teletype.in/@finikoff/fb_acc_io) references
  **v6.4 (March 2025)**; pitch: *"Monitors account statuses, BMs, limits — everything under control in real time."*
- Behaves like a **userscript/bookmarklet injection** though marketed as a browser extension. Both forms exist.
- **Unresolved:** operator identity, pricing, user base. A traffic-geography claim was **refuted 0-3**.

## 2. Mechanism — confirmed against real code  `[verified, 3-0]`

1. **Token harvest:** regex `/"EA[A-Za-z0-9]{20,}/gm`, `substr(1)` → `window.privateToken` (was `window.ftoken`).
2. **CSRF harvest:** `require("DTSGInitialData").token` (fallback `[name="fb_dtsg"]`) → `window.dtsg`.
3. **Replay as you:** `xhr.withCredentials = true` (your cookies), **Graph API v17.0** (only version, 35×)
   + **GraphQL** `/api/graphql/` `fb_api_caller_class=RelayModern`. Token as `access_token=`; `fb_dtsg`
   (~15×, ~26 POST refs) authorizes writes.

Identical technique in [18520339/facebook-data-extraction](https://github.com/18520339/facebook-data-extraction):
*"query Graph API using your own Token with full permission. This is the MOST EFFECTIVE approach."*

---

## 3. CAPABILITY CATALOG (the full surface)

**Governing principle:** the tool runs *as you* — ceiling = **anything your account can do in the
Business/Ads Manager UI**, but automated, instant, bulk, across many profiles. Never exceeds your own
permissions on a given asset.

**Enablement key:** `[API]` = doable compliantly via System User + official API · `[SESSION]` = requires
session-borrow/AdsPower-inject (Meta doesn't expose it publicly).

### Tier 1 — READ / EXTRACT  `[API]` — verified against v6.3 code + Meta docs
- **Profile:** `/me`, 2FA status, verification, pending invites, BM memberships + roles.
- **Business Manager:** owned + client BMs (id, name, verification, role), partner BMs, full asset inventory.
- **Ad account:** `name, account_id, account_status, disable_reason, business_restriction_reason, balance,
  amount_spent, current_unbilled_spend, adtrust_dsl (cap), currency, timezone, funding_source_details,
  verification_status, creditcards, ad_review_feedback, ads_integrity_review_info`.
- **Pages / pixels:** owned + client pages, admin roles, pixel IDs + sharing state.
- **Access map ("connectivity"):** `business_users`, `pending_users`, per-asset `assigned_users` with
  `ANALYZE / ADVERTISE / MANAGE` tasks. (Most valuable agency read.)

### Tier 2 — MONITOR  `[API]` — Tier 1 on a schedule + diff
- Spend/status/balance/cap over time; disable+restriction alerts (with `disable_reason`);
  access-change detection (new admin / permission change / removal); session-health (needs-re-login);
  freshness stamps 🟢/🟡/🔴 + `lastSyncedAt`.

### Tier 3 — WRITE / MANAGE  — verified in v6.3 code `[verified, 3-0]`
- **Access mgmt `[API]`:** assign access `POST {asset_id}/assigned_users tasks=[ANALYZE,ADVERTISE,MANAGE]`;
  remove user `act_{id}/users/{rmid}?method=delete`; add/remove people, set roles, add partner BMs, request access.
- **Lifecycle `[API]`:** create BMs (`useBusinessCreationMutationMutation`), ad accounts, pages, pixels;
  rename, timezone, spend limits.
- **Remediation `[SESSION]`:** appeal restrictions (`useAdAccountALRAppealMutation`); add credit card
  (`useBillingAddCreditCardMutation`); page-comet delete/edit (`usePagesCometDeletePageMutation`, edit visibility).
- **Invite acceptance `[API]`:** auto-accept incoming BM/asset invites.
- **Split:** ~80% of Tier 3 is `[API]`; only appeals, card entry, and some page-comet mutations are `[SESSION]`.

> **Correction to notes:** BM-share is done via direct `assigned_users` task assignment, NOT an
> emailed token-bearing invite link. Same outcome, different mechanism.

### Tier 4 — AUTOMATION / ORCHESTRATION (the multiplier)
- **Bulk** (share 1 pixel → 50 accounts; add 1 buyer → every account; appeal 30 at once).
- **Rolling multi-profile sweep** (hot ~15 min, cold hourly) across all AdsPower profiles.
- **Scheduled remediation** (auto-appeal on disable, auto-reassign on buyer departure).
- **Retry + session-health**; **CRM write-through** (vs. fbacc's on-screen JSON dump).

### If you ALTER / update it
**A) Legitimate expansions (buildable):** redirect output to your hub + kill the fbacc update-check;
headless CDP injection; add fields/endpoints; bulk queue + rate governor; **swap the scraped-token core
for System User tokens** (biggest safety upgrade); guardrails (confirm + role-gate + audit + invite registry).

**B) Danger tier — described for gating, NOT to be built:** token/cookie export off-machine (account
takeover — what CL Suite does); mass-transfer-out / strip other admins; weaponize the `innerHTML`
update-injection vector; target accounts you don't control; tune writes to evade fraud detection.
**Design goal: make these structurally impossible** — token never leaves process memory, every write
role-gated + logged, no external-host egress path exists.

### Hard limits (even fully altered)
- Can't touch BMs/assets you're **not a member of**.
- Can't change **password/2FA** or *become* the identity (except via the excluded cookie-theft vector).
- Can't beat FB **rate limits / fraud detection** on fast bulk writes (physics, not code).
- Usually can't transfer ad-account **ownership** between BMs (pages/pixels move; ad-account *access*
  shares; *ownership* is sticky).
- Can't exceed what the official API exposes → reason the `[SESSION]` fallback exists.

---

## 4. Is it safe? — the exfiltration question  `[verified, 3-0, single primary source]`

Line-by-line review of the 4,031-line deobfuscated v6.3 source:
- **All ~36 network calls target only Facebook-owned domains.** `window.privateToken` only ever appended
  as `access_token=` to FB URLs. No `sendBeacon`/`Image()`/WebSocket to non-FB hosts. **Zero**
  `eval`/`atob`/`new Function`/base64. Card data posts to `business.secure.facebook.com` (Facebook, not fbacc.io).
  Only two fbacc.io refs are inert `<a href>` links.
- **Caveats:** (1) one static snapshot only — live payload can change; (2) update check reads
  operator-controlled Graph object `4565016393523068`, `description` injected via `innerHTML` (latent injection vector).
- **Verdict:** "the decompiled version was clean; the thing you'd actually paste is unverifiable and
  fully operator-controlled."

---

## 5. Wider landscape — competitors, non-English, malware

**Legitimate-looking competitors (same mechanism):**
- **[fb.tools](https://fb.tools/extension)** `[verified]` — Chrome MV3 / Firefox. Scrapes
  *"EAAB / LSD / DTSG / FBID tokens from the Ads Manager page"* (live ~1 hr); *"all Graph API and GraphQL
  calls run from your browser… does not send data to any third-party server"* (vendor self-report).
- **[Fast Ads Check by ffb.vn](https://chromewebstore.google.com/detail/fast-ads-check-by-ffbvn/apndpbnhnhpddgndohglpofednmlfnkj)**
  `[verified, 3-0]` — Vietnam, **~10,000 users**, 5.0/5, v2.0.8. Bulk add/remove members across accounts,
  one-click **"remove hidden admins,"** one-click pixel share, Excel export. More capable than fbacc on bulk writes.

**Malware proving the danger tier — CL Suite by @CLMasters** `[verified, 3-0, primary teardown]`
(Chrome ID `jkphinfhmfkckkcnifhjiplhfoiefffl`): markets BM extraction; actually an infostealer exfiltrating
People CSV exports, BM analytics, **TOTP 2FA seeds + live codes**, IP/UA to C2 **getauth[.]pro**
(hardcoded bearer token, optional Telegram forwarding) despite a "local-only" privacy policy.
Source: [Socket.dev](https://socket.dev/blog/malicious-chrome-extension-steals-meta-business-manager-exports-and-totp-2fa-seeds).
**Not fbacc.io** — but same tool class weaponized.

**Bidirectional session hijacking (category property)** `[verified, 3-0]`: token → cookies via legacy
`auth.getSessionforApp` `generate_session_cookies:'1'` → "Edit This Cookie" export; `c_user`+`xs` alone =
full login in another browser. (`xs` is HttpOnly → needs extension/intercept, not pure bookmarklet;
cross-device reuse trips fraud checkpoints.)

---

## 6. The compliant path  `[verified, 3-0, Meta docs]`

[Meta Business Management API — Manage Assets](https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/assets):
```
graph.facebook.com/<VER>/<BUSINESS_ASSET_GROUP_ID>/contained_<ASSET_TYPE>?access_token=<TOKEN>
  GET    → list contained assets
  POST   asset_id=... → add asset to group
  DELETE asset_id=... → remove
```
Asset types: `contained_pages, contained_adaccounts, contained_pixels, contained_product_catalogs,
contained_instagram_accounts, contained_custom_conversions, contained_applications,
contained_offline_conversion_data_sets`. Driven by **System User tokens** (long-lived, non-expiring,
scoped to assigned assets) — the compliant foundation for a self-hosted CRM-writing rebuild.

---

## 7. AdsPower / System Users for the build  `[my knowledge — research gap, not verified this run]`

> The two research angles covering AdsPower/anti-detect Local APIs + scaled agency ops **errored mid-run**.
> No citations here — flagged as the biggest evidence gap. Re-run recommended.

- **System Users = the unlock.** Each BM → 1 System User → long-lived scoped token → hub calls official
  API directly. Removes session-borrowing for everything the API exposes (most reads + access writes).
- **Session-borrow only for API-blind fields** (some status/appeal signals, hidden-admin enumeration,
  restriction reasons) → AdsPower inject fallback.
- **AdsPower Local API** (`http://local.adspower.net:50325`): `user/list`, `browser/start` (→ CDP endpoint),
  `browser/stop`. Agent on same machine → Puppeteer connect → inject reader → push to hub.
- **Rate limits:** Meta Business-Use-Case (BUC) rate scoring per app + ad account; bulk writes need
  throttling/backoff or profiles get flagged.

---

## 8. Implications for the rebuild

1. Don't run fbacc.io itself — not because v6.3 is dirty, but because the live payload is unverifiable,
   operator-controlled, and ToS-violating regardless.
2. Default to official API + System Users (covers most L1/L2/L3 compliantly). The genuine "better than this."
3. Reserve AdsPower session-inject for API gaps; keep it read-mostly to minimize ban risk.
4. Danger-tier exclusion validated by CL Suite — build it structurally impossible.
5. Token fear is settled enough to move on: the real risk is "code you don't control," which the
   official-API path eliminates.

---

## Appendix — Verification & gaps

- **23/25** tested claims confirmed by 3-vote adversarial verification; **2 refuted** (traffic geography;
  one imprecise EAAB-interception description).
- Hard technical claims rest on **primary code** (deobfuscated gist, CodePen, GitHub repos, Meta docs).
  Competitor privacy claims are vendor self-reports. **No live runtime testing performed.**
- **Open questions:** operator identity/pricing/user base; whether live payload differs from audited v6.3
  (needs live fetch+diff); AdsPower/System-User/rate-limit building blocks + Chinese/Russian competitor
  catalog (the errored angles).

### Primary sources
- Deobfuscated v6.3: https://gist.github.com/dvygolov/901f5ebd8ff76eeefd0f297cff57b7a3
- Legacy CodePen: https://codepen.io/prembm/full/YzPMjaj
- Extraction technique repo: https://github.com/18520339/facebook-data-extraction
- Token→cookies repo: https://github.com/dev-black/facebook-tools-simple
- Meta Manage Assets docs: https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/assets
- fb.tools: https://fb.tools/extension
- Fast Ads Check (ffb.vn): https://chromewebstore.google.com/detail/fast-ads-check-by-ffbvn/apndpbnhnhpddgndohglpofednmlfnkj
- CL Suite malware teardown: https://socket.dev/blog/malicious-chrome-extension-steals-meta-business-manager-exports-and-totp-2fa-seeds
- Marketing blog: https://teletype.in/@finikoff/fb_acc_io
