# MetaManager: project context and history

This is the full background on what MetaManager is, why it is built the way it is, and how it got here.
Read this if you are picking the project up and want the reasoning, not just the code.

## What the project is

A self-hosted tool to see and manage all of the Facebook Business assets a team owns, across many
profiles and machines, from one dashboard. Assets means Business Managers, ad accounts, pages,
pixels, and the people who have access. The team runs many Facebook logins, each in its own
anti-detect browser profile (AdsPower), and checking or changing anything today means opening each
one by hand.

It is modeled on fbacc.io, a session-borrowing browser tool for Facebook Business Manager. The
rebuild keeps fbacc's core trick and changes the parts that matter: the data goes to our own hub,
not a third party, and the token is never stored off the machine.

## The core mechanism, and how it matches fbacc.io

fbacc.io does not hack Facebook. It borrows the session you are already logged into. It reads the
access token that Facebook's own web app puts on the page, then calls Facebook's internal Graph
and GraphQL endpoints as you. Our research on the real tool confirmed this: it harvests the
`EAAB...` token and `fb_dtsg`, then replays them against Facebook's own APIs.

Our extension does the same thing. It reads the page token and calls `graph.facebook.com` read
endpoints proactively, so one click pulls the whole asset tree from any Facebook tab with no
manual browsing. There is no registered app, no System User, and no OAuth. The phrase the user
used, "no Graph API, no session user auth", meant no developer app and no System User, which is
exactly this borrowed-session path.

## Locked decisions

- Standalone hub and dashboard first. Fold into the Admin CRM later, once it is proven accurate.
- Session-borrow engine as the always-available layer. It reaches everything the Facebook UI can,
  with no app review.
- Scope is assets the org owns and controls. Centralizing and storing data on our own hub is fine.
- One hard line: no detection-evasion whose purpose is to defeat Facebook enforcement. Rate
  limiting so legitimate bulk work does not trip flags is fine. Making Facebook blind to us is not
  built and is not needed for an owned-asset operation.
- Read first, and prove it correct, before any writes.

## Stack choices, and why

- Hub database: SQLite through Node's built-in `node:sqlite`. The original plan named Postgres, but
  SQLite needs zero install and runs immediately. The schema (nodes plus an edges table, all keyed
  on Facebook ids) ports to Postgres one to one when the hub goes shared.
- Hub server: Node's built-in `http`. No Express, no dependencies.
- Extension: plain MV3, no build step, no framework.
- Dashboard: one vanilla JS single page app served by the hub. No build step. The visual design
  follows a dark purple reference the user supplied, but it only shows real Facebook fields, never
  invented numbers like followers or ROAS.

## How it was built, in order

1. **extractor.js**: the original one-file console script. Reads the token, walks the tree with the
   Graph API, downloads `asset-dump.json`. This proved the borrowed-session read works.
2. **The hub and dashboard**: a Node server that ingests a dump into SQLite and shows a tree plus a
   reverse lookup. The node-and-edges model was chosen here so a shared asset dedupes and the
   reverse lookup is free.
3. **The extension, first attempt (capture and replay)**: an MV3 extension that watched Facebook's
   own `/api/graphql/` calls and replayed them. It was chosen to avoid hardcoding query ids that
   Facebook rotates. It failed in practice: from an Ads Manager tab the settings queries never
   fire, so it returned zero businesses.
4. **The extension, pivot to a proactive token walk**: after the user pointed out that fbacc does
   not need every tab open, the engine changed to read the page token and call the Graph read
   endpoints itself. This is fbacc's real method and it works from any tab in one click. This is
   the current engine.
5. **Multi-profile, changes, and sessions**: profiles dedupe by Facebook id. A changes table diffs
   each sync against stored state (status flips, new assets, new access). A sessions table tracks
   each browser's login status. The dashboard gained a profile filter, a login-status panel with a
   not-logged-in banner, and a recent-changes feed.
6. **The direct-versus-BM fix**: accounts from `/me/adaccounts` were showing as "not in a BM" even
   when they were. The fix reads each account's own `business` field and files it under that BM.
   "Direct" now means an account with no owning business. A newer sync also clears a stale direct
   link left by an older one.
7. **The profile page and progress UI**: the profile page was rebuilt to look like the overview,
   with stat tiles and openable per-BM sections, so a profile with dozens of accounts does not list
   them all at once. The extension popup gained a live progress bar (reading, business N of M,
   sending, done).

## Key technical notes

- **Edge model**: one `edges` table with (src_type, src_id, dst_type, dst_id, relation). Relations
  are member, reaches, owns, client, has, access, direct, shared. Walking edges in either direction
  answers "where does this asset live" and "which profiles can touch it".
- **BM linkage from the asset**: an ad account's BM comes from its `business` field, which is
  authoritative, rather than from the per-BM list calls that can be blocked by permissions.
- **Login detection**: `c_user` (not HttpOnly) means logged in. If the token is missing but
  `c_user` is present, the page just has not finished loading, so the extension retries rather than
  crying logout. Auto-run only fires on Business or Ads Manager URLs where the token exists.
- **Change baseline**: the first sync of a profile does not emit changes. Diffs only start once
  there is a stored state to compare against.
- **Money and currency**: amounts are Facebook minor units (cents). The dashboard groups spend by
  currency instead of summing across currencies, which would be meaningless.

## What is tested, and what needs a live session

- Backend and dashboard are tested end to end with crafted multi-profile dumps: dedup, shared
  assets across BMs and profiles, direct-versus-BM classification, pixel and account links, change
  detection, sessions, and the reverse lookup. The dashboard views were verified with screenshots.
- The extension's own graph walk was exercised in a Node harness against synthetic Facebook
  responses. The three pieces that need a real logged-in session to confirm the exact response
  shapes are: the `business{id,name}` field on `/me/adaccounts`, per-pixel `shared_accounts`, and
  the auto-run timing. The hub tolerates these being present or absent.

## Open items and possible next steps

- A rolling agent that drives the extension across all AdsPower profiles on a machine, on a
  schedule, so the hub stays fresh without a person clicking Extract.
- Move the hub database to Postgres when it becomes a shared service.
- Spend-change alerts with a threshold so they are useful and not noisy.
- Write actions (share, assign, add or remove people) behind confirmations and an audit log. This
  is deliberately not built yet. Read has to be proven correct first.
- Fold the verified data into the Admin CRM once accuracy is confirmed against the Facebook UI.

## Files to know

- `extractor.js`: the original console reader, kept for reference.
- `extension/src/background.js`: the current engine (token walk, progress, auto-run, status).
- `hub/db.js`: schema, ingest, change detection, and every query.
- `hub/public/app.js`: the whole dashboard.
- `README.md`: how to run it and what each part does.
