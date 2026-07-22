// MetaManager — MAIN-world session harvester.
//
// Reverse-engineered from how fbacc.io actually works (research report §2): it does NOT
// wait for you to browse tabs. It reads the session material the Facebook web app already
// holds on the page — the access token (EAAB…), fb_dtsg (CSRF), and your user id — then
// (in background.js) calls Facebook's own read endpoints proactively. One click, any tab,
// no browsing.
//
// This script runs in the PAGE context (MAIN world) so it can read `require(...)` internals
// that the isolated content script can't. It posts what it finds to the content bridge.
(() => {
  'use strict';
  if (window.__fbaccHarvest) return;
  window.__fbaccHarvest = true;

  const req = (name) => { try { return window.require ? window.require(name) : null; } catch { return null; } };

  function harvest() {
    let token = null, dtsg = null, userID = null, name = null;

    // fb_dtsg (CSRF) — most reliable via the page's own module
    const d = req('DTSGInitialData'); if (d && d.token) dtsg = d.token;
    if (!dtsg) { const el = document.querySelector('input[name="fb_dtsg"]'); if (el) dtsg = el.value; }

    // current user
    const cu = req('CurrentUserInitialData');
    if (cu) { userID = cu.USER_ID || cu.ACCOUNT_ID || userID; name = cu.NAME || name; }

    // access token — the FB web app's own EAAB token, embedded in page payloads
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const m = html.match(/"(EAA[A-Za-z0-9]{30,})"/) ||
              html.match(/\["(EAA[A-Za-z0-9]{30,})/) ||
              html.match(/access_token=(EAA[A-Za-z0-9]{30,})/) ||
              html.match(/(EAA[A-Za-z0-9]{80,})/);
    if (m) token = m[1];

    if (!userID) { const um = html.match(/"USER_ID":"(\d+)"/) || html.match(/"userID":"(\d+)"/); if (um) userID = um[1]; }

    return { token, dtsg, userID, name };
  }

  function post() {
    const s = harvest();
    try { window.postMessage({ __fbaccSession: true, ...s }, '*'); } catch {}
    return s;
  }

  // the page hydrates async — retry a few times until we have token + user
  let n = 0;
  const iv = setInterval(() => { const s = post(); if ((s.token && s.userID) || ++n > 12) clearInterval(iv); }, 700);
  post();

  window.addEventListener('message', (e) => { if (e.data && e.data.__fbaccCmd === 'harvest') post(); });
})();
