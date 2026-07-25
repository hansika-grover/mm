'use strict';
const $ = (s) => document.querySelector(s);
const msg = (t, cls = '') => { const m = $('#msg'); m.textContent = t || ''; m.className = cls; };
const bg = (m) => chrome.runtime.sendMessage(m);

function showProgress(p) {
  if (!p) return;
  const box = $('#prog'); box.hidden = false;
  box.className = 'prog' + (p.phase === 'done' ? ' done' : p.phase === 'error' ? ' error' : '');
  $('#bar-fill').style.width = (p.pct || 0) + '%';
  $('#prog-label').innerHTML = `<span>${(p.label || '').replace(/[<>&]/g, '')}</span><span class="pct">${p.pct || 0}%</span>`;
}

// live progress while the popup is open
chrome.runtime.onMessage.addListener((m) => { if (m && m.kind === 'progress') showProgress(m); });

async function activeFbTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tab && /^https:\/\/([^/]+\.)?facebook\.com\//.test(tab.url || '')) ? tab : null;
}

async function refresh() {
  const tab = await activeFbTab();
  let session = null;
  if (tab) { try { session = await chrome.tabs.sendMessage(tab.id, { getSession: true }); } catch {} }
  const { state, cfg } = await bg({ kind: 'get-state' });

  const tok = session && session.token;
  $('#s-tok').textContent = tok ? 'found' : (tab ? 'not found yet' : 'open a FB tab');
  $('#s-tok').className = 'pill ' + (tok ? 'ok' : 'warn');
  $('#s-uid').textContent = (session && session.userID) || (state.session && state.session.userID) || '—';
  $('#s-hub').textContent = (cfg.hubUrl || '').replace(/^https?:\/\//, '');

  if (state.lastResult) {
    $('#result-card').style.display = '';
    const s = state.lastResult.stats || {};
    $('#r-stats').textContent = `${s.businesses||0} BM · ${s.ad_accounts||0} acct · ${s.pages||0} pg · ${s.pixels||0} px · ${s.people||0} ppl`;
    const send = state.lastSend, el = $('#r-send');
    if (send) { el.textContent = send.ok ? 'sent ✓' : 'failed'; el.className = 'pill ' + (send.ok ? 'ok' : 'bad'); }
    else { el.textContent = 'not sent'; el.className = 'pill info'; }
  }
  // show the last progress state if a run is in flight or just finished
  if (state.progress && (Date.now() - (state.progress.at || 0) < 60000)) showProgress(state.progress);
  if (state.lastError) msg(state.lastError, 'err');
}

$('#extract').addEventListener('click', async () => {
  msg('');
  showProgress({ label: 'Starting', pct: 1, phase: 'start' });
  const res = await bg({ kind: 'extract' });
  if (res && res.ok) {
    const s = res.stats || {};
    msg(`Done: ${s.businesses||0} BM · ${s.ad_accounts||0} accts · ${s.people||0} people → sent to hub ✓`, 'ok');
  } else {
    msg((res && res.error) || 'Extract failed', 'err');
  }
  refresh();
});

$('#refresh').addEventListener('click', refresh);
$('#viewdata').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') }));
$('#opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

refresh();
