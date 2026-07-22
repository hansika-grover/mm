// fbacc extractor — ISOLATED-world content bridge.
// Caches the session harvested by inject.js (MAIN world), and can also read the token
// straight from the DOM itself (same technique as the original extractor.js) as a fallback.
'use strict';

let cached = { token: null, dtsg: null, userID: null, name: null };

function scrapeDom() {
  const html = document.documentElement ? document.documentElement.innerHTML : '';
  const tok = (html.match(/"(EAA[A-Za-z0-9]{30,})"/) || html.match(/(EAA[A-Za-z0-9]{80,})/) || [])[1] || null;
  const uid = (html.match(/"USER_ID":"(\d+)"/) || [])[1] || null;
  const dtsg = (document.querySelector('input[name="fb_dtsg"]') || {}).value || null;
  // c_user is the logged-in user id; it is NOT HttpOnly, so its presence = "logged in"
  // even before the app payload (which carries the EAAB token) has loaded.
  const cUser = (document.cookie.match(/(?:^|;\s*)c_user=(\d+)/) || [])[1] || null;
  return { token: tok, userID: uid || cUser, dtsg, cUser };
}

function currentSession() {
  const dom = scrapeDom();
  return {
    token: cached.token || dom.token || null,
    userID: cached.userID || dom.userID || null,
    dtsg: cached.dtsg || dom.dtsg || null,
    cUser: dom.cUser || null,
    loggedIn: !!(dom.cUser || cached.token || dom.token),
    name: cached.name || null,
    url: location.href,
  };
}

// page (inject.js) -> here
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.__fbaccSession !== true) return;
  if (d.token) cached.token = d.token;
  if (d.dtsg) cached.dtsg = d.dtsg;
  if (d.userID) cached.userID = d.userID;
  if (d.name) cached.name = d.name;
  chrome.runtime.sendMessage({ kind: 'session', session: currentSession() }).catch(() => {});
});

// popup/background -> here
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg) return false;
  if (msg.getSession) { window.postMessage({ __fbaccCmd: 'harvest' }, '*'); reply(currentSession()); return false; }
  if (msg.toPage === 'harvest') { window.postMessage({ __fbaccCmd: 'harvest' }, '*'); reply && reply({ ok: true }); return false; }
  return false;
});

// announce once the page settles
setTimeout(() => { window.postMessage({ __fbaccCmd: 'harvest' }, '*');
  chrome.runtime.sendMessage({ kind: 'session', session: currentSession() }).catch(() => {}); }, 1000);
