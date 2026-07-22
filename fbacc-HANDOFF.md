# fbacc — SESSION HANDOFF (read this first)

New chat: read this file, then the 4 docs in this folder, then continue.

## What this project is
Self-hosted, guardrailed dashboard to see + manage ALL our OWN Facebook assets
(profiles → BMs → ad accounts → pages → pixels → who-has-access) across many
AdsPower profiles/machines, centralized, and eventually written into our Admin CRM.

## Files in this folder (read in order)
1. fbacc-HANDOFF.md      — this file
2. fbacc-rebuild-NOTES.md    — original vision/notes
3. fbacc-research-report.md  — verified research + full capability matrix
4. fbacc-build-plan.md       — locked decisions, build steps 0–5, multi-profile graph solution
5. fbacc-one-pager.md        — plain-English explainer
6. extractor.js          — WORKING read-only script (get all assets in one pass → asset-dump.json)

## Decisions locked
- Standalone dashboard first → integrate into Admin CRM once 100% accurate.
- Maximal session-inject engine; official API where it reaches. Stack: Node/TS + Puppeteer, Postgres, React.
- Scope = all assets are OWNED by us. Allowed: centralize/store tokens (encrypted), bulk manage own assets.
- ONE hard line: no detection-evasion to defeat FB enforcement. (Rate-limiting = fine.)

## Rule
One profile perfect first (read → verify vs FB UI) before scaling or adding writes.

## Status / next step
- Piece A DONE: extractor.js reads full asset tree → asset-dump.json. Needs a test run.
- Piece B NEXT: build the dashboard that loads asset-dump.json → shows Profile→BM→assets tree
  + reverse lookup (pick asset → where it lives).
- Blocker for the live AdsPower fleet (later): AdsPower Local API must be enabled (port 50325).

## Restart prompt to paste in the new chat
"Read fbacc-HANDOFF.md and the docs in this folder. extractor.js works. Build the
dashboard that loads asset-dump.json and shows the tree + reverse lookup."
