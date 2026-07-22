# MetaManager

A self-hosted dashboard for all the Facebook Business assets your team owns. It reads every
profile's Business Managers, ad accounts, pages, pixels and people into one place, keeps the
data in a local database, and lets you search it, browse it, and see how everything connects.

It is a rebuild of the fbacc.io tool, changed so the data goes to your own machine instead of
someone else's server.

## How it fetches data

This is the same idea fbacc.io uses. It borrows the session you are already logged into.

1. You open Facebook (Ads Manager or business.facebook.com) in a normal, logged-in tab.
2. The extension reads the access token that Facebook's own web app already put on the page
   (the `EAAB...` string), plus the `c_user` cookie that tells us who is logged in.
3. Using that token, it calls Facebook's own read endpoints as you: `/me`, `/me/businesses`,
   each Business Manager's accounts, pages, pixels, and people, plus `/me/adaccounts`. It
   follows paging so long lists are not cut off.
4. It builds one JSON tree and POSTs it to the hub.
5. The hub saves it and the dashboard shows it.

There is no Facebook developer app, no System User, and no login popup. The token is only used
to talk to Facebook. It never gets sent to the hub. Only the asset data does.

Because the extension asks Facebook directly, one click pulls the whole tree from any tab. You
do not have to open each Business Manager or settings page by hand. This is the part that an
earlier "watch the page and replay its calls" approach could not do, because on an Ads Manager
tab the settings queries never fire.

## Repository layout

```
MetaManager/
  README.md               this file
  PROJECT-CONTEXT.md      the full story: decisions, history, what is tested
  extractor.js            the original console version (kept as a reference)
  extension/              the browser extension (reads Facebook, sends to hub)
  hub/                    the server + database + dashboard
```

## The extension

An MV3 extension for any Chromium browser (Chrome, Edge, AdsPower's SunBrowser).

```
extension/
  manifest.json           permissions, content scripts, background worker
  src/inject.js           runs in the page (MAIN world): finds the token, fb_dtsg, user id
  src/content.js          runs isolated: bridges the page and the extension, DOM token fallback
  src/background.js       the engine: walks Facebook with the token, POSTs to the hub
  popup/                  the button UI: session status, Extract, live progress bar
  options/                settings: hub URL, source label, auto-run, auto-send
  icons/
```

How it works, file by file:

- **inject.js** runs in the page's own world so it can read `require("DTSGInitialData")` and the
  page HTML. It pulls the access token, `fb_dtsg`, and user id and posts them to content.js.
- **content.js** caches that, and also scrapes the token straight from the page HTML and the
  `c_user` cookie as a fallback. When asked, it hands the current session to the background.
  Reading `c_user` is what lets us tell "logged in but the token has not loaded yet" apart from
  "actually logged out".
- **background.js** is the walker. Given a token it calls `graph.facebook.com` read endpoints,
  follows paging, enriches each pixel with the ad accounts it is shared into, and reads
  `/me/adaccounts` with each account's `business` field so accounts file under their real BM. It
  then POSTs the assembled dump to the hub. It also:
  - emits progress events (reading profile, business N of M, sending, done) that the popup shows,
  - auto-runs when a Business or Ads Manager tab finishes loading, throttled per profile,
  - reports login status to the hub, so a logged-out browser is flagged instead of going stale.
- **popup** shows whether the token was found, your user id, the hub URL, a progress bar during
  a run, and the last result. One button runs Extract.
- **options** stores the hub URL, a source label (how the hub tells your browsers apart), and the
  auto-run and auto-send toggles.

Guardrails: it only calls read endpoints, it never writes to Facebook, and the token never
leaves the browser.

## The hub

A small Node server. No dependencies to install. It uses Node's built-in SQLite and HTTP, so you
need Node 22 or newer and nothing else.

```
hub/
  server.js               HTTP server: the API and static file serving
  db.js                   schema, ingest, change detection, and all queries
  public/                 the dashboard (index.html, app.js, styles.css)
  samples/                example dumps you can load without the extension
  data/hub.db             created on first run
```

### Data model

Assets are nodes, keyed by their Facebook id, so the same asset seen from several profiles is
stored once. Relationships are rows in a single `edges` table:

- profile is a member of a business
- profile reaches a business (through an asset it can access, even without formal membership)
- business owns or has a client relation to an ad account or page
- business has a pixel
- business grants access to a person (with role, and a pending flag for invites)
- pixel is shared into an ad account
- profile has an asset directly (a personal account or page with no owning business)

This edge model is what makes the reverse lookup work: pick any asset and you can walk the edges
in either direction to find every business and profile it touches.

Which BM an ad account belongs to comes from the account's own `business` field, not a guess. So
an account files under its real BM, and "direct" is reserved for accounts with no owning business
at all. If an older sync had filed an account as direct, a newer sync that learns its business
removes the stale link automatically.

Two more tables:

- **changes** records diffs between syncs (an account going disabled, a new person, a spend limit
  change). The first sync of a profile is the baseline and does not generate change noise.
- **sessions** records each browser's login status by source label, so the dashboard can flag one
  that is not logged in.

### API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | take one dump, an array, or `{dumps:[...]}` |
| GET  | `/api/summary` | counts, ad status, spend, sessions, recent changes |
| GET  | `/api/tree` | profile then BM then assets, plus direct assets and pixels-on-accounts |
| GET  | `/api/list?type=` | a flat list of one asset type |
| GET  | `/api/lookup?type=&id=` | reverse lookup: every BM and profile an asset is in |
| GET  | `/api/search?q=` | search across all asset types |
| GET  | `/api/changes` | the change log |
| GET  | `/api/sessions` | login status per session |
| POST | `/api/session-status` | the extension reports logged in or out here |
| POST | `/api/session-clear` | dismiss a session row |
| POST | `/api/reset` | wipe the database |

## The dashboard

- **Overview**: count tiles (click one to browse that type), health tiles, charts for account
  status, spend by currency, access by role, assets per BM, and top accounts. Plus a login-status
  panel and a recent-changes feed. A banner warns if any browser is not logged in.
- **Tree**: profile, then BM, then assets. Pixels appear under the ad accounts they are on.
  Assets not in any BM appear under "Direct". A dropdown filters to one profile.
- **Profile page**: laid out like the overview, with stat tiles and each BM as an openable row so
  a profile with dozens of accounts does not dump them all at once.
- **Lists**: every account, page, pixel, or person in a table. The account list shows a pixel
  count, the pixel list shows how many accounts it is on.
- **Reverse lookup** (any asset detail): the BMs it lives in and every profile that can reach it.
  The same account can be in several BMs and several profiles, and it lists all of them.
- **Search**: top bar, matches any asset by name or id.

Navigation uses the browser history, so Back works, and there is a Back button and breadcrumb on
every page.

## Running it

```
cd hub
node server.js
# open http://127.0.0.1:5051
```

Then load the extension:

1. Go to `chrome://extensions`, turn on Developer mode, click Load unpacked, pick `extension/`.
2. Open the extension's Settings and set a Source label for this profile, for example
   `machine-a/profile-1`. This is how the hub tells your browsers apart.
3. Open Facebook logged in, click the extension, hit Extract. Watch the progress bar. When it
   says Done, open the dashboard.

Old data note: if you upgraded and some accounts still show under "Direct", run Extract once more.
The newer extension sends each account's business, and the hub then files it under the right BM
and clears the old link. A reset first is the cleanest way to start fresh.

## What it will not do

- It only reads. There are no write actions, so it cannot change or move anything on Facebook.
- It only sees what your logins can see. It cannot reach assets you do not have access to.
- The access token stays in the browser. It is never stored or sent to the hub.

## Requirements

- Node 22 or newer (for the built-in SQLite). On Windows, use the Windows Node, not an old one
  inside WSL.
- A Chromium browser for the extension.
