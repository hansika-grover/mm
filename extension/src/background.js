// MetaManager — background service worker.
// Proactive walker (fbacc's method): given the page session token, it calls Facebook's
// own read endpoints itself — no browsing — assembles the full tree (incl. profile-direct
// assets + pixel↔account sharing), and POSTs it to the hub. Also: auto-runs when a Facebook
// tab loads, and reports "logged out" so the dashboard can flag dead sessions.
'use strict';

const DEFAULTS = { hubUrl: 'http://127.0.0.1:5051/api/ingest', sourceLabel: '', autoSend: true,
  autoRun: true, autoRunEveryMin: 10, graphVersion: 'v19.0' };
const cfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });
const statusUrl = (hubUrl) => hubUrl.replace(/\/api\/ingest\/?$/, '/api/session-status');

const state = { session: null, lastResult: null, lastError: null, lastSend: null, busy: false };
const setBadge = (t, c) => { chrome.action.setBadgeText({ text: t || '' }); if (c) chrome.action.setBadgeBackgroundColor({ color: c }); };
const arr = (v) => (Array.isArray(v) ? v : []);

// ---- Facebook graph read (token auth, follows pagination) ------------------
function makeGraph(token, V) {
  return async function gAll(path, fields) {
    let url = `https://graph.facebook.com/${V}/${path}?access_token=${encodeURIComponent(token)}&limit=200` +
      (fields ? `&fields=${encodeURIComponent(fields)}` : '');
    const out = [];
    let guard = 0;
    while (url && guard++ < 40) {
      let j; try { j = await (await fetch(url)).json(); } catch (e) { return { error: String(e.message || e) }; }
      if (j.error) return { error: j.error.message || String(j.error) };
      if (Array.isArray(j.data)) { out.push(...j.data); url = (j.paging && j.paging.next) || null; }
      else return j;
    }
    return out;
  };
}

const ACCT_FIELDS = 'account_id,name,account_status,disable_reason,balance,amount_spent,adtrust_dsl,spend_cap,currency,timezone_name,funding_source_details';
const CLIENT_ACCT_FIELDS = 'account_id,name,account_status,disable_reason,balance,amount_spent,currency,timezone_name';

async function walk(session, conf, onProg = () => {}) {
  const g = makeGraph(session.token, conf.graphVersion);
  onProg('Reading your profile', 4);
  const me = await g('me', 'id,name');
  if (me.error) throw new Error('token rejected by Facebook: ' + me.error);
  onProg('Listing Business Managers', 8);
  const bms = await g('me/businesses', 'id,name,verification_status');
  if (bms.error) throw new Error('could not list businesses: ' + bms.error);

  const out = { me: { id: me.id, name: me.name }, fetchedAt: new Date().toISOString(),
    sourceLabel: conf.sourceLabel || null, businesses: [] };

  const list = arr(bms);
  let i = 0;
  for (const bm of list) {
    i++;
    onProg(`Business ${i}/${list.length}: ${bm.name || bm.id}`, 8 + Math.round((i / Math.max(1, list.length)) * 78));
    const [owned, client, pages, cpages, pixels, users, pending] = await Promise.all([
      g(`${bm.id}/owned_ad_accounts`, ACCT_FIELDS), g(`${bm.id}/client_ad_accounts`, CLIENT_ACCT_FIELDS),
      g(`${bm.id}/owned_pages`, 'id,name,verification_status'), g(`${bm.id}/client_pages`, 'id,name'),
      g(`${bm.id}/adspixels`, 'id,name'), g(`${bm.id}/business_users`, 'id,name,email,role'),
      g(`${bm.id}/pending_users`, 'id,email,role'),
    ]);
    // enrich each pixel with the ad accounts it is shared into (pixel ↔ account)
    for (const px of arr(pixels)) {
      const sh = await g(`${px.id}/shared_accounts`, 'account_id,name,currency');
      px.shared_accounts = arr(sh);
    }
    out.businesses.push({ id: bm.id, name: bm.name, verification_status: bm.verification_status,
      owned_ad_accounts: owned, client_ad_accounts: client, owned_pages: pages, client_pages: cpages,
      adspixels: pixels, business_users: users, pending_users: pending });
  }

  // profile-level assets from /me/adaccounts. The `business{id,name}` field tells the hub
  // which BM each account belongs to, so accounts that ARE in a BM are filed under it
  // instead of showing as "not in a BM". Accounts with no business are truly personal.
  onProg('Reading personal assets', 90);
  const [meAcc, mePages] = await Promise.all([
    g('me/adaccounts', ACCT_FIELDS + ',business{id,name}'),
    g('me/accounts', 'id,name,verification_status'),
  ]);
  out.me_ad_accounts = arr(meAcc);
  out.me_pages = arr(mePages);
  return out;
}

async function sendToHub(dump, conf) {
  const res = await fetch(conf.hubUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dump) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 207) throw new Error(`hub ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function reportStatus(conf, status, detail, session) {
  const ident = conf.sourceLabel || (session && (session.userID || session.cUser)) || null;
  if (!ident) return; // nothing to key on — don't create a bogus "unknown" session row
  try {
    await fetch(statusUrl(conf.hubUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_label: ident, fb_user_id: (session && (session.userID || session.cUser)) || null,
        profile_name: (session && session.name) || null, status, detail }) });
  } catch {}
}

const stats = (d) => ({ businesses: d.businesses.length,
  ad_accounts: d.businesses.reduce((n, b) => n + arr(b.owned_ad_accounts).length + arr(b.client_ad_accounts).length, 0) + arr(d.me_ad_accounts).length,
  pages: d.businesses.reduce((n, b) => n + arr(b.owned_pages).length + arr(b.client_pages).length, 0) + arr(d.me_pages).length,
  pixels: d.businesses.reduce((n, b) => n + arr(b.adspixels).length, 0),
  people: d.businesses.reduce((n, b) => n + arr(b.business_users).length + arr(b.pending_users).length, 0) });

async function sessionForTab(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { getSession: true }); } catch { return null; }
}

function emitProgress(label, pct, phase) {
  state.progress = { label, pct, phase, at: Date.now() };
  chrome.runtime.sendMessage({ kind: 'progress', label, pct, phase }).catch(() => {});
}

async function runExtractTab(tabId) {
  if (state.busy) return { ok: false, error: 'already running' };
  state.busy = true; state.lastError = null; setBadge('…', '#4c9ffe');
  emitProgress('Reading session', 2, 'start');
  const conf = await cfg();
  try {
    let session = await sessionForTab(tabId);
    // logged in (c_user present) but the token payload may not have loaded yet — retry briefly
    for (let i = 0; i < 3 && session && session.cUser && !session.token; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      session = await sessionForTab(tabId);
    }
    if (!session || !session.token) {
      const loggedIn = session && (session.cUser || session.loggedIn);
      if (loggedIn) {
        // NOT a logout — token just isn't exposed on this page (e.g. the plain feed)
        state.lastError = 'Logged in, but no ad-manager token on this tab. Open business.facebook.com or Ads Manager and retry.';
        await reportStatus(conf, 'error', 'logged in (c_user present) but no access token on this page', session);
        setBadge('!', '#d29922'); return { ok: false, error: state.lastError };
      }
      state.lastError = 'Not logged in on this browser session.';
      await reportStatus(conf, 'logged_out', 'no c_user cookie — this browser is not logged into Facebook', session);
      setBadge('!', '#f85149'); return { ok: false, error: state.lastError, loggedOut: true };
    }
    const dump = await walk(session, conf, emitProgress);
    const s = stats(dump);
    state.lastResult = { stats: s, at: new Date().toISOString() };
    if (conf.autoSend) {
      emitProgress('Sending to dashboard', 96, 'send');
      const hub = await sendToHub({ ...dump, sourceLabel: dump.sourceLabel || conf.sourceLabel || null }, conf);
      state.lastSend = { ok: true, hub, at: new Date().toISOString() }; setBadge('✓', '#3fb950');
      emitProgress(`Done: ${s.businesses} BMs, ${s.ad_accounts} accounts`, 100, 'done');
    } else { state.pendingDump = dump; setBadge('•', '#4c9ffe'); emitProgress('Extracted (not sent, autosend off)', 100, 'done'); }
    return { ok: true, stats: s };
  } catch (e) {
    const msg = String(e.message || e); state.lastError = msg;
    if (/token rejected|could not list/i.test(msg)) await reportStatus(conf, 'logged_out', msg, state.session);
    setBadge('!', '#f85149'); emitProgress('Failed: ' + msg, 100, 'error'); return { ok: false, error: msg };
  } finally { state.busy = false; }
}

async function runExtract() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([^/]+\.)?facebook\.com\//.test(tab.url || ''))
    return { ok: false, error: 'Open a facebook.com tab (Ads Manager / Business Suite), then retry.' };
  return runExtractTab(tab.id);
}

// ---- auto-run when a Facebook tab finishes loading -------------------------
const lastAuto = {};
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab && tab.url || '';
  // only auto-run where the ad-manager token actually exists — avoids false "not logged in"
  // flags from the plain feed. Manual Extract still works from any FB tab.
  if (!/^https:\/\/(business\.facebook\.com|[^/]*\.facebook\.com\/adsmanager|[^/]*\.facebook\.com\/latest)/.test(url)) return;
  const conf = await cfg();
  if (!conf.autoRun) return;
  const key = conf.sourceLabel || String(tabId);
  const t = Date.now();
  if (t - (lastAuto[key] || 0) < (conf.autoRunEveryMin || 10) * 60000) return;
  lastAuto[key] = t;
  setTimeout(() => runExtractTab(tabId), 3000); // let the app payload (token) load
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (!msg) return reply && reply({});
    if (msg.kind === 'session') { state.session = msg.session; if (msg.session && msg.session.token) setBadge('', '#3fb950'); return reply && reply({ ok: true }); }
    if (msg.kind === 'get-state') return reply && reply({ state, cfg: await cfg() });
    if (msg.kind === 'save-cfg') { await chrome.storage.local.set(msg.cfg || {}); return reply && reply({ ok: true }); }
    if (msg.kind === 'extract') return reply && reply(await runExtract());
    if (msg.kind === 'send-pending') {
      if (!state.pendingDump) return reply && reply({ ok: false, error: 'nothing pending' });
      try { const hub = await sendToHub(state.pendingDump, await cfg()); state.lastSend = { ok: true, hub, at: new Date().toISOString() };
        state.pendingDump = null; setBadge('✓', '#3fb950'); return reply && reply({ ok: true, hub }); }
      catch (e) { return reply && reply({ ok: false, error: String(e.message || e) }); }
    }
    return reply && reply({});
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => setBadge('', '#4c9ffe'));
