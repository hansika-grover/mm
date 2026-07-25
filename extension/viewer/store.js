'use strict';
// MetaManager viewer — in-browser data layer. Ingests the extension's stored asset
// dumps into the same node+edge model the hub's db.js builds, and answers the exact
// /api/* shapes the dashboard app.js expects — so the dashboard runs unchanged with
// no server. Multi-profile: every dump stored in this browser is merged (dedup by id).

(function () {
  const businesses = new Map();  // bm_id -> node
  const accounts = new Map();    // account_id -> node
  const pages = new Map();       // page_id -> node
  const pixels = new Map();      // pixel_id -> node
  const people = new Map();      // person_id -> node
  const profiles = new Map();    // fb_user_id -> node
  let edges = [];                // {src_type,src_id,dst_type,dst_id,relation,role,pending}

  const asList = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []));
  const acctId = (x) => {
    if (x == null) return null;
    if (typeof x === 'string') return x.replace(/^act_/, '');
    return (x.account_id != null ? String(x.account_id) : String(x.id || '').replace(/^act_/, '')) || null;
  };
  const bmRaw = (bm) => {
    const { owned_ad_accounts, client_ad_accounts, owned_pages, client_pages, adspixels,
      business_users, pending_users, ...rest } = bm;
    return JSON.stringify(rest);
  };
  const edgeKey = (e) => `${e.src_type}|${e.src_id}|${e.dst_type}|${e.dst_id}|${e.relation}`;
  const edgeSet = new Set();
  const addEdge = (st, si, dt, di, rel, role, pending) => {
    const e = { src_type: st, src_id: String(si), dst_type: dt, dst_id: String(di), relation: rel, role: role || null, pending: pending || 0 };
    const k = edgeKey(e);
    if (edgeSet.has(k)) { // update role/pending on the existing edge
      const ex = edges.find((x) => edgeKey(x) === k); if (ex) { ex.role = e.role; ex.pending = e.pending; }
      return;
    }
    edgeSet.add(k); edges.push(e);
  };
  const delEdges = (pred) => { edges = edges.filter((e) => { const drop = pred(e); if (drop) edgeSet.delete(edgeKey(e)); return !drop; }); };

  function upAcct(a) {
    const id = acctId(a); if (!id) return null;
    const prev = accounts.get(id) || {};
    const full = ('account_status' in a) || ('balance' in a) || ('amount_spent' in a) || ('funding_source_details' in a) || ('created_time' in a);
    accounts.set(id, {
      account_id: id,
      name: a.name ?? prev.name ?? null,
      account_status: a.account_status ?? prev.account_status ?? null,
      disable_reason: a.disable_reason ?? prev.disable_reason ?? null,
      balance: a.balance ?? prev.balance ?? null,
      amount_spent: a.amount_spent ?? prev.amount_spent ?? null,
      spend_cap: (a.adtrust_dsl ?? a.spend_cap) ?? prev.spend_cap ?? null,
      currency: a.currency ?? prev.currency ?? null,
      timezone: (a.timezone_name ?? a.timezone) ?? prev.timezone ?? null,
      funding: a.funding_source_details ? JSON.stringify(a.funding_source_details) : (prev.funding ?? null),
      last_synced_at: a.__at ?? prev.last_synced_at ?? null,
      raw: full ? JSON.stringify(a) : (prev.raw ?? JSON.stringify(a)),
    });
    return id;
  }
  function upPage(p) {
    if (!p || !p.id) return null;
    const prev = pages.get(p.id) || {};
    pages.set(p.id, { page_id: p.id, name: p.name ?? prev.name ?? null,
      verification_status: p.verification_status ?? prev.verification_status ?? null,
      last_synced_at: p.__at ?? prev.last_synced_at ?? null,
      raw: (('category' in p) || ('verification_status' in p) || Object.keys(p).length > 2) ? JSON.stringify(p) : (prev.raw ?? JSON.stringify(p)) });
    return p.id;
  }
  function upPixel(px, at) {
    if (!px || !px.id) return null;
    const prev = pixels.get(px.id) || {};
    pixels.set(px.id, { pixel_id: px.id, name: px.name ?? prev.name ?? null,
      last_synced_at: at ?? prev.last_synced_at ?? null, raw: JSON.stringify(px) });
    for (const sa of asList(px.shared_accounts || px.assigned_accounts)) {
      const aid = acctId(sa); if (!aid) continue;
      if (sa && sa.name) upAcct(sa);
      addEdge('pixel', px.id, 'ad_account', aid, 'shared', null, 0);
    }
    return px.id;
  }

  function ingest(dump) {
    if (!dump || !dump.me || !dump.me.id) return;
    const at = dump.fetchedAt || null;
    const pid = dump.me.id, pname = dump.me.name || null;
    const prevP = profiles.get(pid) || {};
    profiles.set(pid, { fb_user_id: pid, name: pname || prevP.name || null,
      source_label: dump.sourceLabel || prevP.source_label || null, last_synced_at: at || prevP.last_synced_at || null });

    for (const bm of asList(dump.businesses)) {
      if (!bm || !bm.id) continue;
      const prevB = businesses.get(bm.id) || {};
      businesses.set(bm.id, { bm_id: bm.id, name: bm.name ?? prevB.name ?? null,
        verification_status: bm.verification_status ?? prevB.verification_status ?? null,
        last_synced_at: at ?? prevB.last_synced_at ?? null, raw: bmRaw(bm) });
      addEdge('profile', pid, 'business', bm.id, 'member', null, 0);
      for (const a of asList(bm.owned_ad_accounts)) { const id = upAcct({ ...a, __at: at }); if (id) addEdge('business', bm.id, 'ad_account', id, 'owns', null, 0); }
      for (const a of asList(bm.client_ad_accounts)) { const id = upAcct({ ...a, __at: at }); if (id) addEdge('business', bm.id, 'ad_account', id, 'client', null, 0); }
      for (const p of asList(bm.owned_pages)) { const id = upPage({ ...p, __at: at }); if (id) addEdge('business', bm.id, 'page', id, 'owns', null, 0); }
      for (const p of asList(bm.client_pages)) { const id = upPage({ ...p, __at: at }); if (id) addEdge('business', bm.id, 'page', id, 'client', null, 0); }
      for (const px of asList(bm.adspixels)) { const id = upPixel(px, at); if (id) addEdge('business', bm.id, 'pixel', id, 'has', null, 0); }
      const access = (u, pending) => { if (!u || !u.id) return;
        const prevU = people.get(u.id) || {};
        people.set(u.id, { person_id: u.id, name: u.name ?? prevU.name ?? null, email: u.email ?? prevU.email ?? null,
          last_synced_at: at ?? prevU.last_synced_at ?? null, raw: JSON.stringify(u) });
        addEdge('business', bm.id, 'person', u.id, 'access', u.role || null, pending); };
      for (const u of asList(bm.business_users)) access(u, 0);
      for (const u of asList(bm.pending_users)) access(u, 1);
    }

    const ownersOf = (t, xid) => [...new Set(edges.filter((e) => e.src_type === 'business' && e.dst_type === t && e.dst_id === String(xid)).map((e) => e.src_id))];
    const linkProfileAsset = (t, xid, biz) => {
      if (biz && biz.id) {
        const prevB = businesses.get(biz.id) || {};
        businesses.set(biz.id, { bm_id: biz.id, name: biz.name ?? prevB.name ?? null,
          verification_status: prevB.verification_status ?? null, last_synced_at: at ?? prevB.last_synced_at ?? null, raw: prevB.raw ?? null });
        addEdge('business', biz.id, t, xid, 'owns', null, 0);
      }
      const owners = ownersOf(t, xid);
      if (owners.length) {
        delEdges((e) => e.src_type === 'profile' && e.src_id === String(pid) && e.dst_type === t && e.dst_id === String(xid) && e.relation === 'direct');
        for (const b of owners) addEdge('profile', pid, 'business', b, 'reaches', null, 0);
      } else {
        addEdge('profile', pid, t, xid, 'direct', null, 0);
      }
    };
    for (const a of asList(dump.me_ad_accounts || dump.direct_ad_accounts)) { const id = upAcct({ ...a, __at: at }); if (id) linkProfileAsset('ad_account', id, a.business); }
    for (const p of asList(dump.me_pages || dump.direct_pages)) { const id = upPage({ ...p, __at: at }); if (id) linkProfileAsset('page', id, p.business); }
    for (const px of asList(dump.me_pixels || dump.direct_pixels)) { const id = upPixel(px, at); if (id) linkProfileAsset('pixel', id, px.business || px.owner_business); }
  }

  // ---- freshness (same thresholds as the hub) ------------------------------
  function freshness(iso) {
    if (!iso) return 'unknown';
    const age = Date.now() - Date.parse(iso);
    if (Number.isNaN(age)) return 'unknown';
    if (age < 30 * 60e3) return 'fresh';
    if (age < 6 * 3600e3) return 'aging';
    return 'stale';
  }

  // ---- edge query helpers --------------------------------------------------
  const dstOf = (st, si, dt, rels) => edges.filter((e) => e.src_type === st && e.src_id === String(si) && e.dst_type === dt && (!rels || rels.includes(e.relation)));
  const srcOf = (dt, di, st, rels) => edges.filter((e) => e.dst_type === dt && e.dst_id === String(di) && e.src_type === st && (!rels || rels.includes(e.relation)));

  const pixelsForAccount = (aid) => srcOf('ad_account', aid, 'pixel', ['shared']).map((e) => pixels.get(e.src_id)).filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const withPixels = (a) => ({ ...a, pixels: pixelsForAccount(a.account_id) });
  const accountsForPixel = (pid) => dstOf('pixel', pid, 'ad_account', ['shared']).map((e) => accounts.get(e.dst_id)).filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // businesses that contain an asset (owns/client/has)
  const bmsOf = (t, id) => srcOf(t, id, 'business').map((e) => { const b = businesses.get(e.src_id); return b ? { bm_id: b.bm_id, name: b.name, relation: e.relation } : null; }).filter(Boolean);
  const businessesForAsset = (t, id) => srcOf(t, id, 'business').map((e) => { const b = businesses.get(e.src_id); return b ? { ...b, relation: e.relation } : null; }).filter(Boolean);
  const profilesForBusiness = (bmId) => dstOf('profile', null, 'business') // placeholder, replaced below
    ;

  // profiles that are MEMBERS of a business
  const profsForBiz = (bmId) => edges.filter((e) => e.src_type === 'profile' && e.dst_type === 'business' && e.dst_id === String(bmId) && e.relation === 'member')
    .map((e) => { const p = profiles.get(e.src_id); return p ? { ...p, freshness: freshness(p.last_synced_at), role: e.role } : null; }).filter(Boolean);
  const directProfilesForAsset = (t, id) => edges.filter((e) => e.src_type === 'profile' && e.dst_type === t && e.dst_id === String(id) && e.relation === 'direct')
    .map((e) => { const p = profiles.get(e.src_id); return p ? { ...p, freshness: freshness(p.last_synced_at), relation: 'direct' } : null; }).filter(Boolean);

  const bizForProfile = (pid) => {
    const rows = edges.filter((e) => e.src_type === 'profile' && e.src_id === String(pid) && e.dst_type === 'business' && (e.relation === 'member' || e.relation === 'reaches'));
    const byBm = new Map();
    for (const e of rows) { const cur = byBm.get(e.dst_id) || { is_member: 0 }; if (e.relation === 'member') cur.is_member = 1; byBm.set(e.dst_id, cur); }
    return [...byBm.entries()].map(([bmId, v]) => { const b = businesses.get(bmId); return b ? { ...b, is_member: v.is_member } : null; }).filter(Boolean)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };
  const directAssets = (pid, t, map, k) => edges.filter((e) => e.src_type === 'profile' && e.src_id === String(pid) && e.dst_type === t && e.relation === 'direct')
    .filter((e) => !edges.some((b) => b.src_type === 'business' && b.dst_type === t && b.dst_id === e.dst_id))
    .map((e) => map.get(e.dst_id)).filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const assetsOfBusiness = (bmId) => ({
    ad_accounts: dstOf('business', bmId, 'ad_account').map((e) => ({ ...accounts.get(e.dst_id), relation: e.relation })).filter((x) => x.account_id).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    pages: dstOf('business', bmId, 'page').map((e) => ({ ...pages.get(e.dst_id), relation: e.relation })).filter((x) => x.page_id).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    pixels: dstOf('business', bmId, 'pixel').map((e) => pixels.get(e.dst_id)).filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    people: dstOf('business', bmId, 'person').map((e) => ({ ...people.get(e.dst_id), role: e.role, pending: e.pending })).filter((x) => x.person_id).sort((a, b) => (a.pending - b.pending) || (a.name || '').localeCompare(b.name || '')),
  });

  // ---- API-shaped query functions -----------------------------------------
  const sortByName = (a, b) => (a.name || '').localeCompare(b.name || '');

  function summary() {
    const statusMap = new Map();
    for (const a of accounts.values()) { const s = a.account_status; statusMap.set(s, (statusMap.get(s) || 0) + 1); }
    const adStatus = [...statusMap.entries()].map(([s, n]) => ({ s, n })).sort((a, b) => (a.s ?? 999) - (b.s ?? 999));
    return {
      counts: { profiles: profiles.size, businesses: businesses.size, ad_accounts: accounts.size, pages: pages.size, pixels: pixels.size, people: people.size },
      adStatus,
      profiles: [...profiles.values()].map((p) => ({ ...p, freshness: freshness(p.last_synced_at) })).sort(sortByName),
      sweeps: [], sessions: [], changesCount: 0, recentChanges: [],
    };
  }

  function tree() {
    return [...profiles.values()].sort(sortByName).map((p) => {
      const businessesArr = bizForProfile(p.fb_user_id).map((b) => ({
        ...b,
        ad_accounts: assetsOfBusiness(b.bm_id).ad_accounts.map(withPixels),
        pages: assetsOfBusiness(b.bm_id).pages,
        pixels: assetsOfBusiness(b.bm_id).pixels,
        people: assetsOfBusiness(b.bm_id).people,
      }));
      const direct = {
        ad_accounts: directAssets(p.fb_user_id, 'ad_account', accounts, 'account_id').map(withPixels),
        pages: directAssets(p.fb_user_id, 'page', pages, 'page_id'),
        pixels: directAssets(p.fb_user_id, 'pixel', pixels, 'pixel_id'),
      };
      return { ...p, freshness: freshness(p.last_synced_at), businesses: businessesArr, direct };
    });
  }

  function list(type) {
    if (type === 'ad_account') return [...accounts.values()].sort((a, b) => Number(b.amount_spent || 0) - Number(a.amount_spent || 0))
      .map((a) => ({ ...a, bms: bmsOf('ad_account', a.account_id), pixel_count: pixelsForAccount(a.account_id).length }));
    if (type === 'pixel') return [...pixels.values()].sort(sortByName)
      .map((p) => ({ ...p, bms: bmsOf('pixel', p.pixel_id), account_count: accountsForPixel(p.pixel_id).length }));
    if (type === 'page') return [...pages.values()].sort(sortByName).map((p) => ({ ...p, bms: bmsOf('page', p.page_id) }));
    if (type === 'person') return [...people.values()].sort(sortByName).map((p) => ({
      ...p, bms: srcOf('person', p.person_id, 'business').map((e) => { const b = businesses.get(e.src_id); return b ? { bm_id: b.bm_id, name: b.name, role: e.role, pending: e.pending } : null; }).filter(Boolean) }));
    if (type === 'business') return [...businesses.values()].sort(sortByName).map((b) => {
      const n = (t) => dstOf('business', b.bm_id, t).length;
      return { ...b, counts: { ad_accounts: n('ad_account'), pages: n('page'), pixels: n('pixel'), people: n('person') } };
    });
    if (type === 'profile') return [...profiles.values()].sort(sortByName).map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
    return [];
  }

  function lookup(type, id) {
    id = String(id);
    const node = { business: businesses.get(id), ad_account: accounts.get(id), page: pages.get(id), pixel: pixels.get(id), person: people.get(id), profile: profiles.get(id) }[type];
    if (node === undefined && !['business', 'ad_account', 'page', 'pixel', 'person', 'profile'].includes(type)) throw new Error('unknown type: ' + type);
    if (!node) return null;
    const res = { type, id, entity: node, businesses: [], profiles: [], related: [] };
    if (type === 'business') {
      res.businesses = [{ ...node, relation: 'self' }];
      res.profiles = profsForBiz(id);
      res.assets = assetsOfBusiness(id);
    } else if (type === 'ad_account' || type === 'page' || type === 'pixel') {
      res.businesses = businessesForAsset(type, id);
      const seen = new Set(); const add = (p) => { if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); } };
      for (const b of res.businesses) for (const p of profsForBiz(b.bm_id)) add(p);
      for (const p of directProfilesForAsset(type, id)) add(p);
      if (type === 'ad_account') res.pixels = pixelsForAccount(id);
      if (type === 'pixel') res.accounts = accountsForPixel(id);
    } else if (type === 'person') {
      res.businesses = srcOf('person', id, 'business').map((e) => { const b = businesses.get(e.src_id); return b ? { ...b, role: e.role, pending: e.pending } : null; }).filter(Boolean);
      const seen = new Set();
      for (const b of res.businesses) for (const p of profsForBiz(b.bm_id)) if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); }
    } else if (type === 'profile') {
      res.businesses = bizForProfile(id);
      res.profiles = [{ ...node, freshness: freshness(node.last_synced_at) }];
      res.direct = { ad_accounts: directAssets(id, 'ad_account', accounts, 'account_id'), pages: directAssets(id, 'page', pages, 'page_id'), pixels: directAssets(id, 'pixel', pixels, 'pixel_id') };
      res.session = null;
    }
    return res;
  }

  function search(q) {
    if (!q || !q.trim()) return [];
    const t = q.trim().toLowerCase();
    const out = [];
    const hit = (s) => String(s || '').toLowerCase().includes(t);
    for (const b of businesses.values()) if (hit(b.name) || hit(b.bm_id)) out.push({ type: 'business', id: b.bm_id, name: b.name, sub: b.verification_status });
    for (const a of accounts.values()) if (hit(a.name) || hit(a.account_id)) out.push({ type: 'ad_account', id: a.account_id, name: a.name, sub: `act_${a.account_id} · ${a.currency || ''}` });
    for (const p of pages.values()) if (hit(p.name) || hit(p.page_id)) out.push({ type: 'page', id: p.page_id, name: p.name, sub: p.page_id });
    for (const p of pixels.values()) if (hit(p.name) || hit(p.pixel_id)) out.push({ type: 'pixel', id: p.pixel_id, name: p.name, sub: p.pixel_id });
    for (const p of people.values()) if (hit(p.name) || hit(p.email) || hit(p.person_id)) out.push({ type: 'person', id: p.person_id, name: p.name, sub: p.email });
    for (const p of profiles.values()) if (hit(p.name) || hit(p.fb_user_id)) out.push({ type: 'profile', id: p.fb_user_id, name: p.name, sub: p.fb_user_id });
    return out;
  }

  // ---- route an /api/* path to the right query (mirrors hub/server.js) ------
  function localApi(pathAndQuery) {
    const [path, qs] = pathAndQuery.split('?');
    const params = new URLSearchParams(qs || '');
    if (path === '/api/summary') return summary();
    if (path === '/api/tree') return { profiles: tree() };
    if (path === '/api/list') return { type: params.get('type') || '', rows: list(params.get('type') || '') };
    if (path === '/api/search') return { results: search(params.get('q') || '') };
    if (path === '/api/sessions') return { sessions: [] };
    if (path === '/api/changes') return { changes: [] };
    if (path === '/api/lookup') { const r = lookup(params.get('type'), params.get('id')); return r || { error: 'not found' }; }
    return { error: 'no such endpoint' };
  }

  async function loadAndBuild() {
    businesses.clear(); accounts.clear(); pages.clear(); pixels.clear(); people.clear(); profiles.clear();
    edges = []; edgeSet.clear();
    let store = {};
    try { store = await chrome.storage.local.get(['dumps', 'lastDump']); } catch {}
    const dumps = store.dumps && typeof store.dumps === 'object' ? Object.values(store.dumps) : [];
    if (!dumps.length && store.lastDump) dumps.push(store.lastDump);   // back-compat
    for (const d of dumps) { try { ingest(d); } catch (e) { console.error('[MetaManager] ingest error', e); } }
    return dumps.length;
  }

  // expose to app.js
  window.MMStore = { localApi, loadAndBuild, count: () => profiles.size };
  window.STORE_READY = loadAndBuild();
  // rebuild + refresh when a new extract lands
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && (c.dumps || c.lastDump)) {
      window.STORE_READY = loadAndBuild().then(() => { if (typeof window.route === 'function') window.route(); });
    }
  });
})();
