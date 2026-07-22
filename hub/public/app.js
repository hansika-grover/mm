'use strict';
// MetaManager hub dashboard — vanilla SPA, hash-history routing (browser Back works).

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const api = async (p) => { try { return await (await fetch(p)).json(); } catch { return null; } };
let toastT;
function toast(m, k = '') { const t = $('#toast'); t.textContent = m; t.className = 'toast ' + k; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3000); }

// ---- domain helpers --------------------------------------------------------
const TYPE = {
  business:   { label:'Business Manager', plural:'Business Managers', icon:'building', tint:'#b197fc', abbrKey:'name' },
  ad_account: { label:'Ad account',       plural:'Ad accounts',       icon:'card',     tint:'#7b9ef8' },
  page:       { label:'Page',             plural:'Pages',             icon:'globe',    tint:'#6fcf97' },
  pixel:      { label:'Pixel',            plural:'Pixels',            icon:'target',   tint:'#f2c94c' },
  person:     { label:'Person',           plural:'People',            icon:'user',     tint:'#f096c8' },
  profile:    { label:'Profile',          plural:'Profiles',          icon:'users',    tint:'#9da3c8' },
};
const idKey = { business:'bm_id', ad_account:'account_id', page:'page_id', pixel:'pixel_id', person:'person_id', profile:'fb_user_id' };

const AD_STATUS = { 1:['Active','good'],2:['Disabled','bad'],3:['Unsettled','warn'],7:['Pending review','warn'],
  8:['Pending settlement','warn'],9:['Grace period','warn'],100:['Pending closure','bad'],101:['Closed','bad'],
  201:['Active','good'],202:['Closed','bad'] };
const adStatus = (c) => { const [t, k] = AD_STATUS[c] || [c == null ? 'Unknown' : `Status ${c}`, 'muted']; return `<span class="badge b-${k}">${esc(t)}</span>`; };
function money(minor, cur) {
  if (minor == null || minor === '') return '—';
  const v = Number(minor) / 100; if (Number.isNaN(v)) return esc(minor);
  try { return new Intl.NumberFormat(undefined, { style:'currency', currency: cur || 'USD' }).format(v); }
  catch { return `${v.toFixed(2)} ${cur || ''}`.trim(); }
}
const fmtN = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : ''+(n ?? 0);
const fmtDate = (i) => i ? new Date(i).toLocaleString() : '—';
const fresh = (f) => `<span class="badge b-muted"><span class="dot ${f||'unknown'}"></span>${{fresh:'fresh',aging:'aging',stale:'stale'}[f]||'no data'}</span>`;
const verify = (v) => v ? `<span class="badge ${/^verified$/i.test(v)?'b-good':'b-muted'}">${esc(String(v).replace(/_/g,' '))}</span>` : '';
const abbr = (s) => (String(s||'?').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2) || '?').toUpperCase();
const SESSION = { ok:['b-good','logged in'], logged_out:['b-bad','NOT logged in'], error:['b-warn','error'] };
const sessionBadge = (st) => { const [k, l] = SESSION[st] || ['b-muted', st || 'unknown']; return `<span class="badge ${k}">${l}</span>`; };
const CHANGE = { added:['b-primary','added'], status:['b-warn','status'], disabled:['b-bad','disabled'], access:['b-accent','new access'], cap:['b-warn','limit'] };
const changeBadge = (k) => { const [c, l] = CHANGE[k] || ['b-muted', k]; return `<span class="badge ${c}">${l}</span>`; };

const ICONS = {
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  building:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
  card:'<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  globe:'<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  left:'<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  right:'<polyline points="9 18 15 12 9 6"/>',
};
const icon = (n, sz = 17) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]||''}</svg>`;

const go = (hash) => { location.hash = hash; };
const link = (type, id) => `#detail/${type}/${encodeURIComponent(id)}`;

// ---- chart helpers (SVG, no deps; all from real data) ----------------------
const SERIES = ['#7b9ef8','#b197fc','#6fcf97','#f2c94c','#5ad1c8','#f096c8','#f0a070','#8fa0e0'];
function donut(segs, { size = 148, thick = 20, center } = {}) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thick) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const arcs = segs.filter((s) => s.value > 0).map((s) => {
    const len = s.value / total * C;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thick}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len; return el;
  }).join('');
  const legend = segs.map((s) => `<div class="lg"><span class="dot2" style="background:${s.color}"></span><span class="lgl">${esc(s.label)}</span><span class="lgv">${s.disp ?? s.value}</span></div>`).join('');
  return `<div class="donutwrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arcs}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="dc-n">${center?.value ?? total}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="dc-l">${esc(center?.label ?? 'total')}</text></svg>
    <div class="legend">${legend}</div></div>`;
}
function barsHTML(items) {
  if (!items.length) return '<div class="muted">No data yet</div>';
  const max = Math.max(1, ...items.map((i) => i.value));
  return items.map((i) => `<div class="barrow"><div class="top"><span>${esc(i.label)}</span><span class="mono">${esc(i.disp ?? i.value)}</span></div>
    <div class="bartrack"><div class="barfill" style="width:${Math.max(2, Math.round(i.value / max * 100))}%;background:${i.color || 'linear-gradient(90deg,var(--primary),var(--accent))'}"></div></div></div>`).join('');
}

// ---- router ----------------------------------------------------------------
async function route() {
  const raw = location.hash.slice(1) || 'overview';
  const parts = raw.split('/').map(decodeURIComponent);
  const view = parts[0];
  $$('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('href') === '#' + view));
  $('#app').innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
  try {
    if (view === 'overview') return await renderOverview();
    if (view === 'tree') return await renderTree();
    if (view === 'list') return await renderList(parts[1]);
    if (view === 'detail') return await renderDetail(parts[1], parts[2]);
    return await renderOverview();
  } catch (e) { $('#app').innerHTML = `<div class="empty"><div class="big">🚫</div>${esc(e.message||e)}</div>`; }
}
window.addEventListener('hashchange', route);

function crumbs(trail) {
  // trail: [{label, hash}] last item = current (no hash)
  const c = $('#crumbs');
  const canBack = trail.length > 1;
  const items = trail.map((t, i) => i === trail.length - 1
    ? `<span class="cur">${esc(t.label)}</span>`
    : `<span class="c" data-h="${esc(t.hash)}">${esc(t.label)}</span>`).join('<span class="sep">/</span>');
  c.innerHTML =
    (canBack ? `<button class="backbtn" id="backbtn">${icon('left',15)} Back</button>` : '') +
    `<div class="crumb-trail">${items}</div>`;
  if (canBack) $('#backbtn').onclick = () => history.back();
  $$('.crumb-trail .c', c).forEach((n) => n.onclick = () => go(n.dataset.h));
}

// ---- OVERVIEW --------------------------------------------------------------
async function renderOverview() {
  const [s, acctsR, pagesR, peopleR, bizR] = await Promise.all([
    api('/api/summary'), api('/api/list?type=ad_account'), api('/api/list?type=page'),
    api('/api/list?type=person'), api('/api/list?type=business'),
  ]);
  if (!s) throw new Error('Backend not connected');
  crumbs([{ label:'Overview' }]);
  const c = s.counts;
  const accts = acctsR?.rows || [], pages = pagesR?.rows || [], people = peopleR?.rows || [], biz = bizR?.rows || [];

  // ---- KPI tiles (asset counts, clickable) ----
  const kpis = [
    ['profile','profiles'],['business','businesses'],['ad_account','ad_accounts'],
    ['page','pages'],['pixel','pixels'],['person','people'],
  ].map(([type, key]) => `
    <a class="kpi click" href="#list/${type}">
      <div class="ic" style="background:${TYPE[type].tint}22;color:${TYPE[type].tint}">${icon(TYPE[type].icon)}</div>
      <span class="arrow">${icon('right',15)}</span>
      <div class="n">${c[key] ?? 0}</div><div class="l">${TYPE[type].plural}</div></a>`).join('');

  // ---- metric tiles (health) ----
  const isActive = (a) => a.account_status === 1 || a.account_status === 201;
  const activeN = accts.filter(isActive).length;
  const disabledN = accts.filter((a) => a.account_status === 2).length;
  const verifiedBM = biz.filter((b) => /^verified$/i.test(b.verification_status || '')).length;
  const pendingN = people.filter((p) => (p.bms || []).some((b) => b.pending)).length;
  const verifiedPg = pages.filter((p) => /^verified$/i.test(p.verification_status || '')).length;
  const metrics = [
    ['Active accounts', activeN, 'good'], ['Disabled accounts', disabledN, 'bad'],
    ['Verified BMs', verifiedBM, 'accent'], ['Pending invites', pendingN, 'warn'],
    ['Verified pages', verifiedPg, ''],
  ].map(([l, n, k]) => `<div class="mstat"><div class="n ${k}">${n}</div><div class="l">${l}</div></div>`).join('');

  // ---- chart data (real aggregates) ----
  const statusSeg = (s.adStatus || []).map((r) => { const [t, k] = AD_STATUS[r.s] || ['Status ' + r.s, 'muted'];
    return { label: t, value: r.n, color: { good:'#6fcf97', bad:'#f07070', warn:'#f2c94c', muted:'#7478a0' }[k] }; });

  const curMap = {};
  for (const a of accts) { const cu = a.currency || '—'; curMap[cu] = (curMap[cu] || 0) + Number(a.amount_spent || 0); }
  const curBars = Object.entries(curMap).sort((a, b) => b[1] - a[1]).map(([cu, v], i) =>
    ({ label: cu, value: v, disp: cu === '—' ? (v/100).toFixed(2) : money(v, cu), color: SERIES[i % SERIES.length] }));

  const roleMap = {};
  for (const p of people) for (const b of (p.bms || [])) { const role = b.pending ? 'pending' : (b.role || 'member'); roleMap[role] = (roleMap[role] || 0) + 1; }
  const roleBars = Object.entries(roleMap).sort((a, b) => b[1] - a[1]).map(([r, n], i) => ({ label: r, value: n, color: SERIES[i % SERIES.length] }));

  const total = (b) => b.counts.ad_accounts + b.counts.pages + b.counts.pixels + b.counts.people;
  const bmTop = [...biz].sort((a, b) => total(b) - total(a)).slice(0, 8);
  const bmMaxTot = Math.max(1, ...bmTop.map(total));
  const seg = (v, color) => v ? `<span style="width:${v / bmMaxTot * 100}%;background:${color}"></span>` : '';
  const stacked = bmTop.map((b) => `<div class="barrow"><div class="top"><span>${esc(b.name || b.bm_id)}</span><span class="mono">${total(b)}</span></div>
    <div class="bartrack stacked">${seg(b.counts.ad_accounts,'var(--primary)')}${seg(b.counts.pages,'var(--good)')}${seg(b.counts.pixels,'var(--warn)')}${seg(b.counts.people,'var(--accent)')}</div></div>`).join('')
    || '<div class="muted">No businesses yet</div>';
  const bmLegend = `<div class="chartlegend">
    <span class="cl"><span class="dot2" style="background:var(--primary)"></span>Accounts</span>
    <span class="cl"><span class="dot2" style="background:var(--good)"></span>Pages</span>
    <span class="cl"><span class="dot2" style="background:var(--warn)"></span>Pixels</span>
    <span class="cl"><span class="dot2" style="background:var(--accent)"></span>People</span></div>`;

  const topAcc = [...accts].sort((a, b) => Number(b.amount_spent || 0) - Number(a.amount_spent || 0))
    .slice(0, 7).map((a, i) => ({ label: a.name || ('act_' + a.account_id), value: Number(a.amount_spent || 0),
      disp: money(a.amount_spent, a.currency), color: SERIES[i % SERIES.length] }));

  const pageSeg = [
    { label:'Verified', value: verifiedPg, color:'#6fcf97' },
    { label:'Not verified', value: pages.length - verifiedPg, color:'#7478a0' },
  ];

  const profRows = (s.profiles || []).map((p) => `
    <tr class="click" data-h="${link('profile',p.fb_user_id)}">
      <td class="namecell"><span class="av" style="background:#9da3c822;color:#c7ccec">${abbr(p.name)}</span>
        <div><div style="font-weight:600">${esc(p.name||'—')}</div><div class="dim mono" style="font-size:11px">${esc(p.fb_user_id)}</div></div></td>
      <td>${fresh(p.freshness)}</td><td class="muted">${fmtDate(p.last_synced_at)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">No profiles yet — run the extractor extension.</td></tr>';
  const sweepRows = (s.sweeps || []).slice(0, 6).map((w) => `<tr><td>${esc(w.profile_name||w.profile_id||'—')}</td>
    <td class="mono">${w.bm_count??0}</td><td>${w.errors&&w.errors.length?`<span class="badge b-bad">${w.errors.length} err</span>`:'<span class="badge b-good">clean</span>'}</td>
    <td class="muted">${fmtDate(w.ingested_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No ingests yet</td></tr>';

  // login status (point 4) + recent changes (point 5)
  const sessions = s.sessions || [];
  const sessName = (x) => x.profile_name || (x.source_label && x.source_label !== 'unknown' ? x.source_label : 'an unlabeled session');
  const loggedOut = sessions.filter((x) => x.status === 'logged_out');
  const banner = loggedOut.length ? `<div class="banner warn">⚠ ${loggedOut.length} browser session(s) are <b>not logged in</b> — their data may be stale. Re-open Facebook and log in: ${esc(loggedOut.map(sessName).join(', '))}</div>` : '';
  const sessRows = sessions.map((x) => `<tr>
    <td class="namecell"><span class="av" style="background:#9da3c822;color:#c7ccec">${abbr(sessName(x))}</span>
      <div><div style="font-weight:600">${esc(sessName(x))}</div><div class="dim mono" style="font-size:11px">${esc(x.source_label || '')}</div></div></td>
    <td>${sessionBadge(x.status)}</td><td class="muted">${fmtDate(x.checked_at)}</td>
    <td><span class="dismiss" data-sess="${esc(x.source_label || '')}" title="Dismiss">✕</span></td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No sessions yet — run the extension.</td></tr>';
  const changeRows = (s.recentChanges || []).map((c) => `<tr class="click" data-h="${link(c.entity_type, c.entity_id)}">
    <td>${changeBadge(c.kind)}</td>
    <td><span class="type-tag t-${c.entity_type}">${TYPE[c.entity_type]?.label || c.entity_type}</span> <span style="font-weight:600">${esc(c.entity_name || c.entity_id)}</span></td>
    <td class="muted">${c.old_val ? esc(c.old_val) + ' → ' : ''}${esc(c.new_val || '')}</td>
    <td class="muted">${fmtDate(c.at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No changes yet — differences appear after the second sync of a profile.</td></tr>';

  $('#app').innerHTML = `
    <div class="pagehead"><h1>Overview</h1><div class="sub">Everything the hub has ingested. Click any tile to browse that asset type.</div></div>
    ${banner}
    <div class="stats">${kpis}</div>
    <div class="metrics">${metrics}</div>
    <div class="grid2">
      <div class="card"><h3>Login status · sessions</h3>
        <table><thead><tr><th>Profile / session</th><th>Status</th><th>Checked</th><th></th></tr></thead><tbody>${sessRows}</tbody></table></div>
      <div class="card"><h3>Recent changes${s.changesCount ? ` · ${s.changesCount}` : ''}</h3>
        <table><thead><tr><th></th><th>Asset</th><th>Change</th><th>When</th></tr></thead><tbody>${changeRows}</tbody></table></div>
    </div>
    <div class="grid3">
      <div class="chartcard"><h3>Ad account status</h3>${donut(statusSeg, { center:{ value:c.ad_accounts, label:'accounts' } })}</div>
      <div class="chartcard"><h3>Spend by currency</h3>${barsHTML(curBars)}</div>
      <div class="chartcard"><h3>Access grants by role</h3>${barsHTML(roleBars)}</div>
    </div>
    <div class="grid3">
      <div class="chartcard"><h3>Assets per Business Manager</h3>${stacked}${bmLegend}</div>
      <div class="chartcard"><h3>Top ad accounts by spend</h3>${barsHTML(topAcc)}</div>
      <div class="chartcard"><h3>Page verification</h3>${pages.length ? donut(pageSeg, { center:{ value:pages.length, label:'pages' } }) : '<div class="muted">No pages yet</div>'}</div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Profiles</h3>
        <table><thead><tr><th>Profile</th><th>Freshness</th><th>Last synced</th></tr></thead><tbody>${profRows}</tbody></table></div>
      <div class="card"><h3>Recent ingests</h3>
        <table><thead><tr><th>Profile</th><th>BMs</th><th>Result</th><th>When</th></tr></thead><tbody>${sweepRows}</tbody></table></div>
    </div>`;
  bindRowNav();
  $$('.dismiss[data-sess]').forEach((n) => n.onclick = async (e) => {
    e.stopPropagation();
    await fetch('/api/session-clear', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_label: n.dataset.sess }) });
    renderOverview();
  });
}

// ---- LIST (browsable category) --------------------------------------------
async function renderList(type) {
  if (!TYPE[type]) throw new Error('Unknown list: ' + type);
  const { rows } = (await api('/api/list?type=' + type)) || { rows: [] };
  crumbs([{ label:'Overview', hash:'#overview' }, { label: TYPE[type].plural }]);

  const bmChips = (bms) => (bms||[]).slice(0,3).map(b =>
    `<span class="badge b-accent" data-h="${link('business',b.bm_id)}" style="cursor:pointer">${esc(b.name||b.bm_id)}${b.role?` · ${esc(b.role)}`:''}</span>`).join(' ')
    + ((bms||[]).length>3 ? ` <span class="muted">+${bms.length-3}</span>` : '');

  let head = '', body = '';
  if (type === 'ad_account') {
    head = '<th>Ad account</th><th>Status</th><th>Spent</th><th>Balance</th><th>Limit</th><th>Pixels</th><th>Business Manager</th>';
    body = rows.map(a => `<tr class="click" data-h="${link('ad_account',a.account_id)}">
      <td class="namecell"><span class="av" style="background:#7b9ef822;color:#a9c1fb">${abbr(a.name)}</span>
        <div><div style="font-weight:600">${esc(a.name||'—')}</div><div class="dim mono" style="font-size:11px">act_${esc(a.account_id)}</div></div></td>
      <td>${adStatus(a.account_status)}</td><td class="mono">${money(a.amount_spent,a.currency)}</td>
      <td class="mono">${money(a.balance,a.currency)}</td><td class="mono">${money(a.spend_cap,a.currency)}</td>
      <td>${a.pixel_count?`<span class="badge b-warn">${a.pixel_count} pixel${a.pixel_count>1?'s':''}</span>`:'<span class="muted">—</span>'}</td>
      <td>${bmChips(a.bms)}</td></tr>`).join('');
  } else if (type === 'page') {
    head = '<th>Page</th><th>ID</th><th>Verification</th><th>Business Manager</th>';
    body = rows.map(p => `<tr class="click" data-h="${link('page',p.page_id)}">
      <td class="namecell"><span class="av" style="background:#6fcf9722;color:#8fe0b3">${abbr(p.name)}</span><span style="font-weight:600">${esc(p.name||'—')}</span></td>
      <td class="dim mono">${esc(p.page_id)}</td><td>${verify(p.verification_status)||'<span class="muted">—</span>'}</td><td>${bmChips(p.bms)}</td></tr>`).join('');
  } else if (type === 'pixel') {
    head = '<th>Pixel</th><th>ID</th><th>On ad accounts</th><th>Business Manager</th>';
    body = rows.map(p => `<tr class="click" data-h="${link('pixel',p.pixel_id)}">
      <td class="namecell"><span class="av" style="background:#f2c94c22;color:#f4d27a">${abbr(p.name)}</span><span style="font-weight:600">${esc(p.name||'—')}</span></td>
      <td class="dim mono">${esc(p.pixel_id)}</td>
      <td>${p.account_count?`<span class="badge b-primary">${p.account_count} account${p.account_count>1?'s':''}</span>`:'<span class="muted">—</span>'}</td>
      <td>${bmChips(p.bms)}</td></tr>`).join('');
  } else if (type === 'person') {
    head = '<th>Person</th><th>Email</th><th>Access (BM · role)</th>';
    body = rows.map(p => `<tr class="click" data-h="${link('person',p.person_id)}">
      <td class="namecell"><span class="av" style="background:#f096c822;color:#f3add4">${abbr(p.name||p.email)}</span><span style="font-weight:600">${esc(p.name||'—')}</span></td>
      <td class="muted">${esc(p.email||'—')}</td><td>${(p.bms||[]).slice(0,4).map(b=>`<span class="badge ${b.pending?'b-warn':'b-accent'}" data-h="${link('business',b.bm_id)}" style="cursor:pointer">${esc(b.name)}${b.pending?' · pending':b.role?` · ${esc(b.role)}`:''}</span>`).join(' ')}</td></tr>`).join('');
  } else if (type === 'business') {
    head = '<th>Business Manager</th><th>Verification</th><th>Accounts</th><th>Pages</th><th>Pixels</th><th>People</th>';
    body = rows.map(b => `<tr class="click" data-h="${link('business',b.bm_id)}">
      <td class="namecell"><span class="av" style="background:#b197fc22;color:#cbb8fd">${abbr(b.name)}</span>
        <div><div style="font-weight:600">${esc(b.name||'—')}</div><div class="dim mono" style="font-size:11px">${esc(b.bm_id)}</div></div></td>
      <td>${verify(b.verification_status)||'<span class="muted">—</span>'}</td>
      <td class="mono">${b.counts.ad_accounts}</td><td class="mono">${b.counts.pages}</td><td class="mono">${b.counts.pixels}</td><td class="mono">${b.counts.people}</td></tr>`).join('');
  } else if (type === 'profile') {
    head = '<th>Profile</th><th>Freshness</th><th>Last synced</th>';
    body = rows.map(p => `<tr class="click" data-h="${link('profile',p.fb_user_id)}">
      <td class="namecell"><span class="av" style="background:#9da3c822;color:#c7ccec">${abbr(p.name)}</span>
        <div><div style="font-weight:600">${esc(p.name||'—')}</div><div class="dim mono" style="font-size:11px">${esc(p.fb_user_id)}</div></div></td>
      <td>${fresh(p.freshness)}</td><td class="muted">${fmtDate(p.last_synced_at)}</td></tr>`).join('');
  }

  $('#app').innerHTML = `
    <div class="pagehead"><h1>${TYPE[type].plural}</h1><div class="sub">${rows.length} total · click a row for where it lives &amp; who can reach it.</div></div>
    <div class="card">${rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : '<div class="empty">Nothing here yet.</div>'}</div>`;
  bindRowNav();
}

// ---- PROFILE DETAIL (mini-overview + collapsible lists) --------------------
async function renderProfileDetail(id) {
  const data = (await api('/api/tree')) || { profiles: [] };
  const p = (data.profiles || []).find((x) => x.fb_user_id === id);
  if (!p) throw new Error('Profile not found');
  const sess = ((await api('/api/sessions')) || { sessions: [] }).sessions.find((s) => s.fb_user_id === id);
  crumbs([{ label:'Overview', hash:'#overview' }, { label:'Profiles', hash:'#list/profile' }, { label: p.name || id }]);

  const uniq = (rows, k) => new Set(rows.map((r) => r[k])).size;
  const allAccts = [...p.businesses.flatMap((b) => b.ad_accounts), ...p.direct.ad_accounts];
  const allPages = [...p.businesses.flatMap((b) => b.pages), ...p.direct.pages];
  const allPixels = [...p.businesses.flatMap((b) => b.pixels), ...p.direct.pixels];
  const allPeople = p.businesses.flatMap((b) => b.people);
  const stat = (n, l, tint) => `<div class="mstat"><div class="n" style="color:${tint}">${n}</div><div class="l">${l}</div></div>`;

  // row builders
  const rowAcct = (a) => `<tr class="click" data-h="${link('ad_account',a.account_id)}">
    <td class="namecell"><span class="type-tag t-ad_account">ACCT</span><span style="font-weight:600">${esc(a.name||'—')}</span> <span class="dim mono">act_${esc(a.account_id)}</span></td>
    <td>${adStatus(a.account_status)}</td><td class="mono">${money(a.amount_spent,a.currency)}</td>
    <td>${(a.pixels||[]).length?`<span class="badge b-warn">${a.pixels.length} pixel${a.pixels.length>1?'s':''}</span>`:''}</td></tr>`;
  const rowPage = (pg) => `<tr class="click" data-h="${link('page',pg.page_id)}">
    <td class="namecell"><span class="type-tag t-page">PAGE</span><span style="font-weight:600">${esc(pg.name||'—')}</span> <span class="dim mono">${esc(pg.page_id)}</span></td><td>${verify(pg.verification_status)}</td></tr>`;
  const rowPixel = (px) => `<tr class="click" data-h="${link('pixel',px.pixel_id)}">
    <td class="namecell"><span class="type-tag t-pixel">PIXEL</span><span style="font-weight:600">${esc(px.name||'—')}</span> <span class="dim mono">${esc(px.pixel_id)}</span></td></tr>`;
  const rowPerson = (pe) => `<tr class="click" data-h="${link('person',pe.person_id)}">
    <td class="namecell"><span class="type-tag t-person">PERSON</span><span style="font-weight:600">${esc(pe.name||pe.email||'—')}</span> <span class="dim">${esc(pe.email||'')}</span></td>
    <td><span class="badge ${pe.pending?'b-warn':'b-accent'}">${pe.pending?'pending · ':''}${esc(pe.role||'member')}</span></td></tr>`;
  const listBlock = (label, items, row) => items.length ? `<div class="group-label" style="margin:10px 6px 4px">${label} · ${items.length}</div>
    <div class="inner-list"><table><tbody>${items.map(row).join('')}</tbody></table></div>` : '';

  // one collapsible per BM
  const bmBlocks = p.businesses.map((b) => {
    const counts = `<span class="sumcount"><span><b>${b.ad_accounts.length}</b> accts</span><span><b>${b.pages.length}</b> pages</span><span><b>${b.pixels.length}</b> pixels</span><span><b>${b.people.length}</b> people</span></span>`;
    const openLink = `<span class="linkish" style="font-weight:500;font-size:12px" data-h="${link('business',b.bm_id)}">open ›</span>`;
    return `<details class="coll">
      <summary><span class="type-tag t-business">BM</span> ${esc(b.name||b.bm_id)} ${b.is_member?'':'<span class="badge b-muted">reachable</span>'} ${verify(b.verification_status)} ${counts}</summary>
      <div class="coll-body">
        <div style="text-align:right;padding:6px 8px 0">${openLink}</div>
        ${listBlock('Ad accounts', b.ad_accounts, rowAcct)}
        ${listBlock('Pages', b.pages, rowPage)}
        ${listBlock('Pixels', b.pixels, rowPixel)}
        ${listBlock('People (access)', b.people, rowPerson)}
      </div></details>`;
  }).join('');

  const directBlock = (p.direct.ad_accounts.length || p.direct.pages.length || p.direct.pixels.length) ? `
    <details class="coll">
      <summary><span class="type-tag t-profile">DIRECT</span> Personal assets, not in any BM
        <span class="sumcount"><span><b>${p.direct.ad_accounts.length}</b> accts</span><span><b>${p.direct.pages.length}</b> pages</span><span><b>${p.direct.pixels.length}</b> pixels</span></span></summary>
      <div class="coll-body">
        ${listBlock('Ad accounts', p.direct.ad_accounts, rowAcct)}
        ${listBlock('Pages', p.direct.pages, rowPage)}
        ${listBlock('Pixels', p.direct.pixels, rowPixel)}
      </div></details>` : '';

  $('#app').innerHTML = `
    <div class="detail-head">
      <div class="title"><span class="av" style="background:#9da3c822;color:#c7ccec">${abbr(p.name)}</span>
        ${esc(p.name||id)} <span class="type-tag t-profile">Profile</span></div>
      <div class="kv">
        <div><div class="k">FB ID</div><div class="v mono">${esc(id)}</div></div>
        <div><div class="k">Login status</div><div class="v">${sess ? sessionBadge(sess.status) : '<span class="muted">unknown</span>'}</div></div>
        <div><div class="k">Freshness</div><div class="v">${fresh(p.freshness)}</div></div>
        <div><div class="k">Last synced</div><div class="v">${fmtDate(p.last_synced_at)}</div></div>
      </div></div>
    <div class="metrics" style="grid-template-columns:repeat(5,1fr)">
      ${stat(p.businesses.length,'Business Managers','#b197fc')}
      ${stat(uniq(allAccts,'account_id'),'Ad accounts','#7b9ef8')}
      ${stat(uniq(allPages,'page_id'),'Pages','#6fcf97')}
      ${stat(uniq(allPixels,'pixel_id'),'Pixels','#f2c94c')}
      ${stat(uniq(allPeople,'person_id'),'People','#f096c8')}
    </div>
    <div class="sectiontitle">Business Managers <span class="count-pill">${p.businesses.length}</span></div>
    ${bmBlocks || '<div class="muted" style="padding:8px">No Business Managers.</div>'}
    ${directBlock}`;
  bindRowNav();
}

// ---- DETAIL (reverse lookup) ----------------------------------------------
async function renderDetail(type, id) {
  if (type === 'profile') return renderProfileDetail(id);
  const r = await api(`/api/lookup?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  if (!r || r.error) throw new Error((r && r.error) || 'Not found');
  const e = r.entity;
  const name = e.name || e.email || e[idKey[type]] || id;
  crumbs([{ label:'Overview', hash:'#overview' }, { label: TYPE[type].plural, hash:'#list/'+type }, { label: name }]);

  const kv = [];
  const add = (k, v) => { if (v != null && v !== '') kv.push(`<div><div class="k">${k}</div><div class="v">${v}</div></div>`); };
  add('FB ID', `<span class="mono">${esc(id)}</span>`);
  if (type === 'ad_account') {
    add('Status', adStatus(e.account_status)); add('Disable reason', e.disable_reason && esc(e.disable_reason));
    add('Amount spent', money(e.amount_spent, e.currency)); add('Balance', money(e.balance, e.currency));
    add('Spend limit', money(e.spend_cap, e.currency)); add('Currency', e.currency && esc(e.currency));
    add('Timezone', e.timezone && esc(e.timezone));
    if (e.funding) { try { const f = JSON.parse(e.funding); add('Funding', esc(f.display_string || f.type || '—')); } catch {} }
  }
  if (type === 'business') add('Verification', verify(e.verification_status) || '—');
  if (type === 'page') add('Verification', verify(e.verification_status) || '—');
  if (type === 'person') add('Email', esc(e.email || '—'));
  if (type === 'profile') { add('Freshness', fresh(e.freshness)); if (r.session) add('Login status', sessionBadge(r.session.status)); }
  add('Last synced', fmtDate(e.last_synced_at));

  let html = `<div class="detail-head">
    <div class="title"><span class="av" style="background:${TYPE[type].tint}22;color:${TYPE[type].tint}">${abbr(name)}</span>
      ${esc(name)} <span class="type-tag t-${type}">${TYPE[type].label}</span></div>
    <div class="kv">${kv.join('')}</div></div>`;

  // reusable asset section + row builders
  const sect = (title, t, items, row) => (items && items.length) ? `
    <div class="sectiontitle">${icon(TYPE[t].icon,16)} ${title} <span class="count-pill">${items.length}</span></div>
    <div class="card"><table><tbody>${items.map(row).join('')}</tbody></table></div>` : '';
  const rowAcct = (a) => `<tr class="click" data-h="${link('ad_account',a.account_id)}">
    <td class="namecell"><span class="type-tag t-ad_account">ACCT</span><span style="font-weight:600">${esc(a.name||'—')}</span> <span class="dim mono">act_${esc(a.account_id)}</span></td>
    <td>${adStatus(a.account_status)}</td><td class="mono">${money(a.amount_spent,a.currency)}</td>${a.relation?`<td><span class="badge b-primary">${esc(a.relation)}</span></td>`:'<td></td>'}</tr>`;
  const rowPage = (p) => `<tr class="click" data-h="${link('page',p.page_id)}">
    <td class="namecell"><span class="type-tag t-page">PAGE</span><span style="font-weight:600">${esc(p.name||'—')}</span> <span class="dim mono">${esc(p.page_id)}</span></td>
    <td>${p.relation?`<span class="badge b-primary">${esc(p.relation)}</span>`:''} ${verify(p.verification_status)}</td></tr>`;
  const rowPixel = (p) => `<tr class="click" data-h="${link('pixel',p.pixel_id)}">
    <td class="namecell"><span class="type-tag t-pixel">PIXEL</span><span style="font-weight:600">${esc(p.name||'—')}</span> <span class="dim mono">${esc(p.pixel_id)}</span></td></tr>`;
  const rowPerson = (p) => `<tr class="click" data-h="${link('person',p.person_id)}">
    <td class="namecell"><span class="type-tag t-person">PERSON</span><span style="font-weight:600">${esc(p.name||p.email||'—')}</span> <span class="dim">${esc(p.email||'')}</span></td>
    <td><span class="badge ${p.pending?'b-warn':'b-accent'}">${p.pending?'pending · ':''}${esc(p.role||'member')}</span></td></tr>`;

  // BM drilldown: everything inside this business
  if (type === 'business' && r.assets) {
    html += sect('Ad accounts','ad_account',r.assets.ad_accounts,rowAcct);
    html += sect('Pages','page',r.assets.pages,rowPage);
    html += sect('Pixels','pixel',r.assets.pixels,rowPixel);
    html += sect('People','person',r.assets.people,rowPerson);
  }
  // ad account -> pixels assigned to it
  if (type === 'ad_account') html += sect('Pixels assigned to this account','pixel',r.pixels,rowPixel);
  // pixel -> ad accounts it is shared into
  if (type === 'pixel') html += sect('Shared into ad accounts','ad_account',r.accounts,rowAcct);
  // profile -> assets held directly (not in a BM)
  if (type === 'profile' && r.direct) {
    html += sect('Ad accounts directly on this profile (not in a BM)','ad_account',r.direct.ad_accounts,rowAcct);
    html += sect('Pages directly on this profile (not in a BM)','page',r.direct.pages,rowPage);
  }

  // where it lives + who can reach it
  const bizTitle = type==='person' ? 'Has access to (Business Managers)'
    : type==='profile' ? 'Member of (Business Managers)'
    : type==='business' ? '' : 'Lives in (Business Managers)';
  const twoCol = [];
  if (bizTitle) twoCol.push(`<div class="card"><h3>${bizTitle} · ${r.businesses.length}</h3>
    ${r.businesses.length ? `<table><tbody>${r.businesses.map(b=>`<tr class="click" data-h="${link('business',b.bm_id)}">
      <td class="namecell"><span class="av" style="background:#b197fc22;color:#cbb8fd">${abbr(b.name)}</span><span style="font-weight:600">${esc(b.name||'—')}</span></td>
      <td class="dim mono">${esc(b.bm_id)}</td><td>${b.relation&&b.relation!=='self'?`<span class="badge b-primary">${esc(b.relation)}</span>`:''} ${b.role?`<span class="badge ${b.pending?'b-warn':'b-accent'}">${b.pending?'pending · ':''}${esc(b.role)}</span>`:''} ${verify(b.verification_status)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">—</div>'}</div>`);

  const profTitle = type==='profile' ? 'This profile' : 'Profiles that can reach it';
  twoCol.push(`<div class="card"><h3>${profTitle} · ${r.profiles.length}</h3>
    ${r.profiles.length ? `<table><tbody>${r.profiles.map(p=>`<tr class="click" data-h="${link('profile',p.fb_user_id)}">
      <td class="namecell"><span class="av" style="background:#9da3c822;color:#c7ccec">${abbr(p.name)}</span><span style="font-weight:600">${esc(p.name||'—')}</span></td>
      <td class="dim mono">${esc(p.fb_user_id)}</td><td>${fresh(p.freshness)}</td></tr>`).join('')}</tbody></table>
      ${type!=='profile'&&r.profiles.length>1?`<div class="sub" style="margin-top:12px">⚠ Reachable from ${r.profiles.length} profiles — access is shared.</div>`:''}`
      : '<div class="muted">No profile currently reaches this.</div>'}</div>`);

  html += `<div class="grid2" style="margin-top:16px">${twoCol.join('')}</div>`;
  $('#app').innerHTML = html;
  bindRowNav();
}

// ---- TREE ------------------------------------------------------------------
async function renderTree(sel) {
  const data = (await api('/api/tree')) || { profiles: [] };
  const profiles = data.profiles || [];
  crumbs([{ label:'Overview', hash:'#overview' }, { label:'Tree' }]);
  if (!profiles.length) { $('#app').innerHTML = `<div class="empty"><div class="big">🌳</div>No data yet — run the extractor extension.</div>`; return; }
  const options = ['<option value="">All profiles</option>']
    .concat(profiles.map((p) => `<option value="${esc(p.fb_user_id)}"${sel===p.fb_user_id?' selected':''}>${esc(p.name||p.fb_user_id)}</option>`)).join('');
  $('#app').innerHTML = `<div class="pagehead"><h1>Asset tree</h1><div class="sub">Profile → Business Manager → assets (ad accounts show the pixels on them). Assets not in a BM appear under “Direct”. Click any asset for its reverse lookup.</div></div>
    <div class="filterbar"><span class="muted">Profile:</span><select id="pfilter">${options}</select></div><div id="troot"></div>`;
  const host = $('#troot');
  const shown = sel ? profiles.filter((p) => p.fb_user_id === sel) : profiles;
  for (const p of shown) host.append(profileNode(p));
  $('#pfilter').onchange = (e) => renderTree(e.target.value);
  bindRowNav();
}
function collapser(container, collapsed) {
  const c = document.createElement('span'); c.className = 'caret' + (collapsed ? ' collapsed' : ''); c.textContent = '▾';
  if (collapsed) container.classList.add('hidden');
  c.onclick = (e) => { e.stopPropagation(); c.classList.toggle('collapsed'); container.classList.toggle('hidden'); };
  return c;
}
function h(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
function profileNode(p) {
  const wrap = h('div','tree-node'); const kids = h('div','tree-children');
  const head = h('div','profile-head'); const row = h('div','tree-row');
  row.append(collapser(kids,false));
  row.append(h('span','type-tag t-profile','Profile'));
  row.append(h('span',null,`<b>${esc(p.name||'—')}</b> <span class="dim mono">${esc(p.fb_user_id)}</span> · ${fresh(p.freshness)} · ${p.businesses.length} BM`));
  head.append(row); wrap.append(head, kids);
  if (!p.businesses.length) kids.append(h('div','muted','No Business Managers visible.'));
  for (const b of p.businesses) kids.append(bmNode(b));
  // assets held directly by the profile, outside any BM
  const d = p.direct || { ad_accounts: [], pages: [] };
  if (d.ad_accounts.length || d.pages.length) {
    kids.append(h('div','group-label',`Direct — not in any BM · ${d.ad_accounts.length + d.pages.length}`));
    d.ad_accounts.forEach((a) => kids.append(acctLeaf(a)));
    d.pages.forEach((pg) => kids.append(leaf('page', pg.page_id, pg.name, `<span class="dim mono">${esc(pg.page_id)}</span>`)));
  }
  return wrap;
}
// ad-account leaf that also lists the pixels assigned to it (nested, clickable)
function acctLeaf(a) {
  const wrap = h('div');
  wrap.append(leaf('ad_account', a.account_id, a.name,
    `${adStatus(a.account_status)} ${a.relation ? `<span class="badge b-primary">${esc(a.relation)}</span>` : ''} ${money(a.amount_spent, a.currency)}`));
  if (a.pixels && a.pixels.length) {
    const sub = h('div', 'subleaf');
    a.pixels.forEach((px) => sub.append(leaf('pixel', px.pixel_id, px.name, `<span class="dim mono">${esc(px.pixel_id)}</span> · assigned here`)));
    wrap.append(sub);
  }
  return wrap;
}
function bmNode(b) {
  const wrap = h('div','bm-row'); const kids = h('div','tree-children'); const row = h('div','tree-row clickable');
  const car = collapser(kids, true); row.append(car);
  const tot = b.ad_accounts.length + b.pages.length + b.pixels.length + b.people.length;
  row.append(h('span','type-tag t-business','BM'));
  row.append(h('span',null,`<b>${esc(b.name||'—')}</b> <span class="dim mono">${esc(b.bm_id)}</span> ${verify(b.verification_status)} <span class="count-pill">${tot} assets</span>`));
  row.onclick = (e) => { if (e.target !== car) go(link('business', b.bm_id)); };
  wrap.append(row, kids);
  const grp = (label, t, items, fn) => { if (!items.length) return;
    kids.append(h('div','group-label',`${label} · ${items.length}`)); items.forEach(it => kids.append(fn(it))); };
  grp('Ad accounts','ad_account',b.ad_accounts,(a)=>acctLeaf(a));
  grp('Pages','page',b.pages,(p)=>leaf('page',p.page_id,p.name,`<span class="badge b-primary">${esc(p.relation)}</span> ${verify(p.verification_status)}`));
  grp('Pixels','pixel',b.pixels,(p)=>leaf('pixel',p.pixel_id,p.name,`<span class="dim mono">${esc(p.pixel_id)}</span>`));
  grp('People','person',b.people,(p)=>leaf('person',p.person_id,p.name||p.email,`${esc(p.email||'')} <span class="badge ${p.pending?'b-warn':'b-accent'}">${p.pending?'pending · ':''}${esc(p.role||'member')}</span>`));
  return wrap;
}
function leaf(type, id, name, meta) {
  const n = h('div','leaf'); n.innerHTML = `<span class="type-tag t-${type}">${TYPE[type].label}</span><b>${esc(name||'—')}</b> <span class="dim">${meta||''}</span>`;
  n.onclick = () => go(link(type, id)); return n;
}

// row navigation via data-h
function bindRowNav() {
  $$('[data-h]').forEach((n) => { if (n.dataset.bound) return; n.dataset.bound = '1';
    n.addEventListener('click', (e) => { e.stopPropagation(); go(n.dataset.h); }); });
}

// ---- search ----------------------------------------------------------------
const si = $('#global-search'), sb = $('#search-results');
let sT;
si.addEventListener('input', () => { clearTimeout(sT); const q = si.value.trim();
  if (!q) { sb.hidden = true; return; }
  sT = setTimeout(async () => {
    const { results } = (await api('/api/search?q=' + encodeURIComponent(q))) || { results: [] };
    if (!results.length) { sb.innerHTML = '<div class="sr muted">No matches</div>'; sb.hidden = false; return; }
    sb.innerHTML = results.slice(0, 40).map(x => `<div class="sr" data-h="${link(x.type,x.id)}">
      <span class="type-tag t-${x.type}">${TYPE[x.type]?.label||x.type}</span>
      <span style="font-weight:500">${esc(x.name||'—')}</span>
      <span class="dim mono" style="margin-left:auto">${esc(x.sub||x.id)}</span></div>`).join('');
    sb.hidden = false;
    $$('.sr[data-h]', sb).forEach(n => n.onclick = () => { sb.hidden = true; si.value = ''; go(n.dataset.h); });
  }, 160);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) sb.hidden = true; });

// ---- boot ------------------------------------------------------------------
route();
