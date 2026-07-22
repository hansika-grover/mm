# MetaManager — browser extension (proactive token walk)

The extraction engine as an MV3 browser extension that reads your **own** Facebook Business
assets **the way fbacc.io actually does** — one click, from any Facebook tab, **no browsing
required**.

## How it works (reverse-engineered from fbacc.io)

fbacc doesn't wait for you to open Business Settings tabs. It reads the **session token the
Facebook web app already holds on the page** and calls Facebook's own read endpoints
**proactively**. This extension does the same:

```
 facebook.com tab (you, logged in — Ads Manager, Business Suite, anywhere)
   ├─ inject.js   (MAIN world)  ── harvests the page session:
   │                                 access token (EAAB…), fb_dtsg, user id
   ├─ content.js  (ISOLATED)    ── bridge + DOM-scrape fallback for the token
   └─ background.js (worker)     ── PROACTIVELY walks the tree with that token:
         /me · /me/businesses · per-BM owned+client ad accounts, pages, pixels,
         business_users, pending_users  (follows pagination)
         → assembles the dump → POSTs to the hub /api/ingest
```

Because it issues the queries itself, **one click pulls the whole tree** — you don't have to
visit each business or each settings page. This is why the earlier passive "capture & replay"
build returned 0 businesses from an Ads Manager tab: that approach could only replay queries
the UI had already fired. This one asks Facebook directly.

Per-account fields captured (same set the fbacc overlay shows): `account_status`,
`disable_reason`, `balance`, `amount_spent`, `adtrust_dsl` (spend limit), `spend_cap`,
`currency`, `timezone_name`, `funding_source_details`.

## What "no Graph API / no System User" means here

This uses your **borrowed page session** — the exact `EAAB…` token the Facebook web app
already uses in your browser. There is **no registered developer app, no System User, no
OAuth, no app review**. That is fbacc.io's mechanism and what your `../extractor.js` proved.
It does call `graph.facebook.com` read endpoints (as your logged-in self) — that is the only
way to answer without browsing every tab.

## Install (Chrome / Edge / AdsPower SunBrowser — all Chromium)

1. Start the hub first (`cd ../hub && node server.js`).
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`.
3. (Optional) extension → **Settings** → set hub URL / source label.

## Use

1. Open **facebook.com** logged in (Ads Manager or business.facebook.com — any page).
2. Click the extension → **Extract & send to hub**.
3. Open the dashboard — the full tree + reverse lookup is populated.

The popup shows whether the **session token** was found on the current tab, your user id, and
the last extract/send result. If the token shows "not found yet", reload the FB tab (the
token is embedded once the page's app payload loads) and retry.

## Guardrails (build plan's hard line)

- **Read-only.** Only `GET` list/read endpoints — no writes.
- **Token never leaves the browser.** It's used to call Facebook directly; only the assembled
  **asset data** is POSTed, and only to your configured hub (default localhost).
- **No detection-evasion.** Uses your real session as-is; nothing spoofed or hidden.

## Files

```
extension/
  manifest.json          # MV3
  src/inject.js          # MAIN-world session harvester (token, fb_dtsg, user id)
  src/content.js         # ISOLATED bridge + DOM token fallback
  src/background.js      # proactive graph walk + POST to hub   (the engine)
  popup/                 # token status + one-click Extract
  options/               # hub URL, source label, auto-send
  icons/
```

## Relationship to `../extractor.js`

Same mechanism as `extractor.js` (page token → Facebook read endpoints), moved into an
extension so it's one click instead of pasting a console script, and extended with pagination
and extra account fields (timezone, spend limit, funding).
