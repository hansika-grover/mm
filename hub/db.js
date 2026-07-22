// MetaManager hub — database layer (Node built-in SQLite).
// Graph model: assets are NODES keyed on their FB global ID (stored once, deduped),
// access/ownership are EDGES. This is what makes reverse lookup work and scales to
// many profiles/machines later (N profiles seeing act_123 = N edges into 1 node).
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.FBACC_DB || path.join(DATA_DIR, 'hub.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  fb_user_id     TEXT PRIMARY KEY,
  name           TEXT,
  source_label   TEXT,
  first_seen_at  TEXT,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS businesses (
  bm_id               TEXT PRIMARY KEY,
  name                TEXT,
  verification_status TEXT,
  last_synced_at      TEXT
);
CREATE TABLE IF NOT EXISTS ad_accounts (
  account_id     TEXT PRIMARY KEY,
  name           TEXT,
  account_status INTEGER,
  disable_reason TEXT,
  balance        TEXT,
  amount_spent   TEXT,
  spend_cap      TEXT,   -- adtrust_dsl
  currency       TEXT,
  timezone       TEXT,   -- timezone_name
  funding        TEXT,   -- funding_source_details JSON
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  page_id             TEXT PRIMARY KEY,
  name                TEXT,
  verification_status TEXT,
  last_synced_at      TEXT
);
CREATE TABLE IF NOT EXISTS pixels (
  pixel_id       TEXT PRIMARY KEY,
  name           TEXT,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS people (
  person_id      TEXT PRIMARY KEY,
  name           TEXT,
  email          TEXT,
  last_synced_at TEXT
);
-- generic relationship edges (dedup + who-can-touch-what + command routing)
CREATE TABLE IF NOT EXISTS edges (
  src_type       TEXT NOT NULL,   -- profile | business
  src_id         TEXT NOT NULL,
  dst_type       TEXT NOT NULL,   -- business | ad_account | page | pixel | person
  dst_id         TEXT NOT NULL,
  relation       TEXT NOT NULL,   -- member | owns | client | has | access
  role           TEXT,            -- role / tasks
  pending        INTEGER DEFAULT 0,
  last_synced_at TEXT,
  PRIMARY KEY (src_type, src_id, dst_type, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst_type, dst_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges (src_type, src_id);
`);

// migrate older DBs that predate the timezone column
try { db.exec('ALTER TABLE ad_accounts ADD COLUMN timezone TEXT'); } catch { /* already present */ }

db.exec(`
-- audit trail of every ingest
CREATE TABLE IF NOT EXISTS sweeps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT,
  profile_name TEXT,
  source_label TEXT,
  fetched_at  TEXT,
  ingested_at TEXT,
  bm_count    INTEGER,
  errors      TEXT
);
-- per-browser-session login status (keyed by agent/profile source label)
CREATE TABLE IF NOT EXISTS sessions (
  source_label TEXT PRIMARY KEY,
  fb_user_id   TEXT,
  profile_name TEXT,
  status       TEXT,   -- ok | logged_out | error
  detail       TEXT,
  checked_at   TEXT
);
-- change log: diffs detected between syncs (status flips, new assets, new access…)
CREATE TABLE IF NOT EXISTS changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT,
  profile_id   TEXT,
  profile_name TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  entity_name  TEXT,
  kind         TEXT,   -- added | status | disabled | access | cap
  field        TEXT,
  old_val      TEXT,
  new_val      TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_at ON changes (id DESC);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes (entity_type, entity_id);
`);

// ---- upsert statements -----------------------------------------------------
const up = {
  profile: db.prepare(`INSERT INTO profiles (fb_user_id,name,source_label,first_seen_at,last_synced_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(fb_user_id) DO UPDATE SET name=excluded.name,
      source_label=COALESCE(excluded.source_label,profiles.source_label),
      last_synced_at=excluded.last_synced_at`),
  business: db.prepare(`INSERT INTO businesses (bm_id,name,verification_status,last_synced_at)
    VALUES (?,?,?,?)
    ON CONFLICT(bm_id) DO UPDATE SET name=COALESCE(excluded.name,businesses.name),
      verification_status=COALESCE(excluded.verification_status,businesses.verification_status),
      last_synced_at=excluded.last_synced_at`),
  adAccount: db.prepare(`INSERT INTO ad_accounts
    (account_id,name,account_status,disable_reason,balance,amount_spent,spend_cap,currency,timezone,funding,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET name=excluded.name,account_status=excluded.account_status,
      disable_reason=excluded.disable_reason,balance=excluded.balance,amount_spent=excluded.amount_spent,
      spend_cap=COALESCE(excluded.spend_cap,ad_accounts.spend_cap),currency=excluded.currency,
      timezone=COALESCE(excluded.timezone,ad_accounts.timezone),
      funding=COALESCE(excluded.funding,ad_accounts.funding),last_synced_at=excluded.last_synced_at`),
  page: db.prepare(`INSERT INTO pages (page_id,name,verification_status,last_synced_at)
    VALUES (?,?,?,?)
    ON CONFLICT(page_id) DO UPDATE SET name=excluded.name,
      verification_status=COALESCE(excluded.verification_status,pages.verification_status),
      last_synced_at=excluded.last_synced_at`),
  pixel: db.prepare(`INSERT INTO pixels (pixel_id,name,last_synced_at) VALUES (?,?,?)
    ON CONFLICT(pixel_id) DO UPDATE SET name=excluded.name, last_synced_at=excluded.last_synced_at`),
  person: db.prepare(`INSERT INTO people (person_id,name,email,last_synced_at) VALUES (?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET name=COALESCE(excluded.name,people.name),
      email=COALESCE(excluded.email,people.email), last_synced_at=excluded.last_synced_at`),
  edge: db.prepare(`INSERT INTO edges (src_type,src_id,dst_type,dst_id,relation,role,pending,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(src_type,src_id,dst_type,dst_id,relation) DO UPDATE SET
      role=excluded.role, pending=excluded.pending, last_synced_at=excluded.last_synced_at`),
  sweep: db.prepare(`INSERT INTO sweeps (profile_id,profile_name,source_label,fetched_at,ingested_at,bm_count,errors)
    VALUES (?,?,?,?,?,?,?)`),
  session: db.prepare(`INSERT INTO sessions (source_label,fb_user_id,profile_name,status,detail,checked_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(source_label) DO UPDATE SET fb_user_id=COALESCE(excluded.fb_user_id,sessions.fb_user_id),
      profile_name=COALESCE(excluded.profile_name,sessions.profile_name),
      status=excluded.status, detail=excluded.detail, checked_at=excluded.checked_at`),
  change: db.prepare(`INSERT INTO changes (at,profile_id,profile_name,entity_type,entity_id,entity_name,kind,field,old_val,new_val)
    VALUES (?,?,?,?,?,?,?,?,?,?)`),
};

// A Graph list field may come back as {error:"..."} instead of an array (the
// extractor passes FB errors through). Tolerate that everywhere.
const asList = (v) => (Array.isArray(v) ? v : []);
const errOf = (v) => (v && !Array.isArray(v) && v.error ? v.error : null);

const AD_STATUS_LABEL = { 1:'Active',2:'Disabled',3:'Unsettled',7:'Pending review',8:'Pending settlement',
  9:'Grace period',100:'Pending closure',101:'Closed',201:'Active',202:'Closed' };
const statusLabel = (c) => AD_STATUS_LABEL[c] || (c == null ? 'Unknown' : 'Status ' + c);
// normalize an ad-account reference (string, {account_id}, {id:'act_123'}) to its numeric id
function acctId(x) {
  if (x == null) return null;
  if (typeof x === 'string') return x.replace(/^act_/, '');
  return (x.account_id != null ? String(x.account_id) : String(x.id || '').replace(/^act_/, '')) || null;
}

/**
 * Ingest one asset-dump.json payload. Idempotent: re-ingesting updates nodes and
 * refreshes edges/timestamps. Detects changes vs the stored state (unless this is the
 * profile's first-ever sync = baseline). Also handles profile-direct assets (not in a
 * BM), pixel↔ad-account sharing, and records the session's login status.
 */
function ingest(dump, opts = {}) {
  if (!dump || typeof dump !== 'object' || !dump.me || !dump.me.id) {
    throw new Error('invalid dump: expected { me:{id,name}, businesses:[...] }');
  }
  const now = new Date().toISOString();
  const fetchedAt = dump.fetchedAt || now;
  const label = opts.sourceLabel || dump.sourceLabel || null;
  const pid = dump.me.id, pname = dump.me.name || null;
  const errors = [];
  const counts = { businesses: 0, ad_accounts: 0, pages: 0, pixels: 0, people: 0, edges: 0, changes: 0 };
  const seen = { acct: new Set(), page: new Set(), pixel: new Set(), person: new Set(), bm: new Set() };

  const tx = () => {
    // baseline gate: only diff once we've seen this profile before
    const track = !!db.prepare('SELECT 1 FROM profiles WHERE fb_user_id=?').get(pid);
    const change = (kind, type, id, name, field, oldv, newv) => {
      if (!track) return;
      up.change.run(now, pid, pname, type, String(id), name || null, kind, field || null,
        oldv == null ? null : String(oldv), newv == null ? null : String(newv));
      counts.changes++;
    };
    const edgeIsNew = (st, si, dt, di, rel) =>
      !db.prepare('SELECT 1 FROM edges WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND relation=?').get(st, si, dt, di, rel);

    up.profile.run(pid, pname, label, fetchedAt, fetchedAt);

    const upsertAcct = (a) => {
      const id = acctId(a); if (!id) return null;
      const prev = db.prepare('SELECT account_status,spend_cap FROM ad_accounts WHERE account_id=?').get(id);
      up.adAccount.run(id, a.name || null, a.account_status ?? null, a.disable_reason ?? null,
        a.balance ?? null, a.amount_spent ?? null, a.adtrust_dsl ?? a.spend_cap ?? null, a.currency ?? null,
        a.timezone_name ?? a.timezone ?? null,
        a.funding_source_details ? JSON.stringify(a.funding_source_details) : null, fetchedAt);
      if (!seen.acct.has(id)) {
        seen.acct.add(id); counts.ad_accounts++;
        if (!prev) change('added', 'ad_account', id, a.name);
        else if (a.account_status != null && prev.account_status != null && Number(prev.account_status) !== Number(a.account_status))
          change(Number(a.account_status) === 2 ? 'disabled' : 'status', 'ad_account', id, a.name, 'status', statusLabel(prev.account_status), statusLabel(a.account_status));
        const nc = a.adtrust_dsl ?? a.spend_cap;
        if (prev && nc != null && prev.spend_cap != null && String(prev.spend_cap) !== String(nc))
          change('cap', 'ad_account', id, a.name, 'spend_limit', prev.spend_cap, nc);
      }
      return id;
    };
    const upsertPage = (p) => {
      if (!p || !p.id) return null;
      const prev = db.prepare('SELECT 1 FROM pages WHERE page_id=?').get(p.id);
      up.page.run(p.id, p.name || null, p.verification_status || null, fetchedAt);
      if (!seen.page.has(p.id)) { seen.page.add(p.id); counts.pages++; if (!prev) change('added','page',p.id,p.name); }
      return p.id;
    };
    const upsertPixel = (px) => {
      if (!px || !px.id) return null;
      const prev = db.prepare('SELECT 1 FROM pixels WHERE pixel_id=?').get(px.id);
      up.pixel.run(px.id, px.name || null, fetchedAt);
      if (!seen.pixel.has(px.id)) { seen.pixel.add(px.id); counts.pixels++; if (!prev) change('added','pixel',px.id,px.name); }
      // pixel shared into ad accounts (pixel -> ad_account edge)
      for (const sa of asList(px.shared_accounts || px.assigned_accounts)) {
        const aid = acctId(sa); if (!aid) continue;
        if (sa && sa.name) up.adAccount.run(aid, sa.name, null,null,null,null,null, sa.currency||null, null,null, fetchedAt);
        up.edge.run('pixel', px.id, 'ad_account', aid, 'shared', null, 0, fetchedAt); counts.edges++;
      }
      return px.id;
    };
    const addAccess = (bm, u, pending) => {
      if (!u || !u.id) return;
      const prev = db.prepare('SELECT 1 FROM people WHERE person_id=?').get(u.id);
      up.person.run(u.id, u.name || null, u.email || null, fetchedAt);
      if (!seen.person.has(u.id)) { seen.person.add(u.id); counts.people++; }
      const isNew = edgeIsNew('business', bm.id, 'person', u.id, 'access');
      up.edge.run('business', bm.id, 'person', u.id, 'access', u.role || null, pending, fetchedAt); counts.edges++;
      if (isNew) change('access', 'person', u.id, u.name || u.email, 'access', null, `${bm.name || bm.id} · ${pending ? 'pending ' : ''}${u.role || 'member'}`);
    };

    for (const bm of asList(dump.businesses)) {
      if (!bm || !bm.id) continue;
      const prevBm = db.prepare('SELECT 1 FROM businesses WHERE bm_id=?').get(bm.id);
      up.business.run(bm.id, bm.name || null, bm.verification_status || null, fetchedAt);
      if (!seen.bm.has(bm.id)) { seen.bm.add(bm.id); counts.businesses++; if (!prevBm) change('added','business',bm.id,bm.name); }
      up.edge.run('profile', pid, 'business', bm.id, 'member', null, 0, fetchedAt); counts.edges++;

      const acctEdge = (a, rel) => { const id = upsertAcct(a); if (id) { up.edge.run('business', bm.id, 'ad_account', id, rel, null, 0, fetchedAt); counts.edges++; } };
      const pageEdge = (p, rel) => { const id = upsertPage(p); if (id) { up.edge.run('business', bm.id, 'page', id, rel, null, 0, fetchedAt); counts.edges++; } };
      for (const a of asList(bm.owned_ad_accounts)) acctEdge(a, 'owns');
      for (const a of asList(bm.client_ad_accounts)) acctEdge(a, 'client');
      for (const p of asList(bm.owned_pages)) pageEdge(p, 'owns');
      for (const p of asList(bm.client_pages)) pageEdge(p, 'client');
      for (const px of asList(bm.adspixels)) { const id = upsertPixel(px); if (id) { up.edge.run('business', bm.id, 'pixel', id, 'has', null, 0, fetchedAt); counts.edges++; } }
      for (const u of asList(bm.business_users)) addAccess(bm, u, 0);
      for (const u of asList(bm.pending_users)) addAccess(bm, u, 1);

      for (const f of ['owned_ad_accounts','client_ad_accounts','owned_pages','client_pages','adspixels','business_users','pending_users']) {
        const e = errOf(bm[f]); if (e) errors.push(`${bm.name || bm.id} · ${f}: ${e}`);
      }
    }

    // profile-level assets from /me/adaccounts etc. An asset's own `business` field is the
    // authoritative BM link: if it has one, the asset lives in that BM (not "direct").
    // "Direct" is reserved for assets with NO owning business at all (truly personal).
    const ownersOf = (t, xid) => db.prepare(
      `SELECT DISTINCT src_id FROM edges WHERE dst_type=? AND dst_id=? AND src_type='business'`).all(t, xid).map((r) => r.src_id);
    const linkProfileAsset = (t, xid, biz) => {
      if (biz && biz.id) {
        up.business.run(biz.id, biz.name || null, null, fetchedAt);
        if (!seen.bm.has(biz.id)) { seen.bm.add(biz.id); if (!db.prepare('SELECT 1 FROM businesses WHERE bm_id=?').get(biz.id)) counts.businesses++; }
        up.edge.run('business', biz.id, t, xid, 'owns', null, 0, fetchedAt); counts.edges++;
      }
      const owners = ownersOf(t, xid);
      if (owners.length) {
        // the profile reaches this asset through its BM(s), so surface those BMs in the profile.
        // Also drop any stale "direct" edge from an older sync (before we knew the BM), so the
        // asset stops showing as "not in a BM".
        db.prepare(`DELETE FROM edges WHERE src_type='profile' AND src_id=? AND dst_type=? AND dst_id=? AND relation='direct'`).run(pid, t, xid);
        for (const b of owners) { up.edge.run('profile', pid, 'business', b, 'reaches', null, 0, fetchedAt); counts.edges++; }
      } else {
        up.edge.run('profile', pid, t, xid, 'direct', null, 0, fetchedAt); counts.edges++;
      }
    };
    for (const a of asList(dump.me_ad_accounts || dump.direct_ad_accounts)) { const id = upsertAcct(a); if (id) linkProfileAsset('ad_account', id, a.business); }
    for (const p of asList(dump.me_pages || dump.direct_pages)) { const id = upsertPage(p); if (id) linkProfileAsset('page', id, p.business); }
    for (const px of asList(dump.me_pixels || dump.direct_pixels)) { const id = upsertPixel(px); if (id) linkProfileAsset('pixel', id, px.business || (px.owner_business)); }

    up.sweep.run(pid, pname, label, fetchedAt, now, counts.businesses, errors.length ? JSON.stringify(errors) : null);
    if (label || pid) up.session.run(label || pid, pid, pname, 'ok', null, now);
  };

  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }

  return { profile: { id: pid, name: pname }, fetchedAt, counts, errors };
}

// Extension calls this when it could NOT extract (logged out / no token) so the
// dashboard can flag the profile/session instead of showing stale data as fine.
function reportSession(s) {
  const label = s.source_label || s.sourceLabel || s.fb_user_id;
  if (!label) throw new Error('source_label or fb_user_id required');
  up.session.run(label, s.fb_user_id || null, s.profile_name || null,
    s.status || 'error', s.detail || null, new Date().toISOString());
  return { ok: true };
}

// ---- freshness helper ------------------------------------------------------
function freshness(iso) {
  if (!iso) return 'unknown';
  const age = Date.now() - Date.parse(iso);
  if (Number.isNaN(age)) return 'unknown';
  if (age < 30 * 60e3) return 'fresh';        // < 30 min
  if (age < 6 * 3600e3) return 'aging';       // < 6 h
  return 'stale';
}

// ---- queries ---------------------------------------------------------------
function summary() {
  const one = (sql) => db.prepare(sql).get().n;
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all()
    .map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
  const sweeps = db.prepare('SELECT * FROM sweeps ORDER BY id DESC LIMIT 25').all()
    .map((s) => ({ ...s, errors: s.errors ? JSON.parse(s.errors) : [] }));
  const statusRows = db.prepare(
    'SELECT account_status AS s, COUNT(*) AS n FROM ad_accounts GROUP BY account_status').all();
  return {
    counts: {
      profiles: one('SELECT COUNT(*) n FROM profiles'),
      businesses: one('SELECT COUNT(*) n FROM businesses'),
      ad_accounts: one('SELECT COUNT(*) n FROM ad_accounts'),
      pages: one('SELECT COUNT(*) n FROM pages'),
      pixels: one('SELECT COUNT(*) n FROM pixels'),
      people: one('SELECT COUNT(*) n FROM people'),
    },
    adStatus: statusRows,
    profiles,
    sweeps,
    sessions: sessions(),
    changesCount: one('SELECT COUNT(*) n FROM changes'),
    recentChanges: changes(8),
  };
}

// login/session status per browser-session (source label)
function sessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY checked_at DESC').all().map((s) => ({
    ...s, freshness: freshness(s.checked_at),
  }));
}

// change log (newest first)
function changes(limit = 100, entity) {
  if (entity && entity.type && entity.id)
    return db.prepare('SELECT * FROM changes WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT ?').all(entity.type, String(entity.id), limit);
  return db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT ?').all(limit);
}

// pixels shared into a given ad account (pixel -> ad_account 'shared' edge)
const pixelsForAccount = db.prepare(
  `SELECT px.* FROM pixels px JOIN edges e ON e.src_id=px.pixel_id
   WHERE e.src_type='pixel' AND e.dst_type='ad_account' AND e.dst_id=? ORDER BY px.name`);
const withPixels = (a) => ({ ...a, pixels: pixelsForAccount.all(a.account_id) });

// Full tree: profile -> businesses -> {ad accounts (+their pixels), pages, pixels, people}
//            plus profile-direct assets that live outside any BM.
function tree() {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  // BMs the profile is a member of OR reaches (via an asset it can access)
  const bmsForProfile = db.prepare(
    `SELECT b.*, MAX(CASE WHEN e.relation='member' THEN 1 ELSE 0 END) AS is_member
     FROM businesses b JOIN edges e ON e.dst_id=b.bm_id
     WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='business' AND e.relation IN ('member','reaches')
     GROUP BY b.bm_id ORDER BY b.name`);
  const acctsForBm = db.prepare(
    `SELECT a.*, e.relation FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`);
  const pagesForBm = db.prepare(
    `SELECT p.*, e.relation FROM pages p JOIN edges e ON e.dst_id=p.page_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='page' ORDER BY p.name`);
  const pixForBm = db.prepare(
    `SELECT px.* FROM pixels px JOIN edges e ON e.dst_id=px.pixel_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='pixel' ORDER BY px.name`);
  const peopleForBm = db.prepare(
    `SELECT pe.*, e.role, e.pending FROM people pe JOIN edges e ON e.dst_id=pe.person_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='person' ORDER BY e.pending, pe.name`);
  // "direct" = profile reaches it AND no business owns it (truly personal)
  const directAssets = (t, tbl, k) => db.prepare(
    `SELECT n.* FROM ${tbl} n JOIN edges e ON e.dst_id=n.${k}
     WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='${t}' AND e.relation='direct'
     AND NOT EXISTS (SELECT 1 FROM edges b WHERE b.dst_type='${t}' AND b.dst_id=n.${k} AND b.src_type='business')
     ORDER BY n.name`);
  const directAccts = directAssets('ad_account', 'ad_accounts', 'account_id');
  const directPages = directAssets('page', 'pages', 'page_id');
  const directPix = directAssets('pixel', 'pixels', 'pixel_id');

  return profiles.map((p) => {
    const businesses = bmsForProfile.all(p.fb_user_id).map((b) => ({
      ...b,
      ad_accounts: acctsForBm.all(b.bm_id).map(withPixels),
      pages: pagesForBm.all(b.bm_id),
      pixels: pixForBm.all(b.bm_id),
      people: peopleForBm.all(b.bm_id),
    }));
    const direct = {
      ad_accounts: directAccts.all(p.fb_user_id).map(withPixels),
      pages: directPages.all(p.fb_user_id),
      pixels: directPix.all(p.fb_user_id),
    };
    return { ...p, freshness: freshness(p.last_synced_at), businesses, direct };
  });
}

function search(q) {
  if (!q || !q.trim()) return [];
  const like = `%${q.trim()}%`;
  const out = [];
  const push = (rows, type, idKey, sub) =>
    rows.forEach((r) => out.push({ type, id: r[idKey], name: r.name, sub: sub(r) }));
  push(db.prepare('SELECT * FROM businesses WHERE name LIKE ? OR bm_id LIKE ? LIMIT 40').all(like, like),
    'business', 'bm_id', (r) => r.verification_status);
  push(db.prepare('SELECT * FROM ad_accounts WHERE name LIKE ? OR account_id LIKE ? LIMIT 40').all(like, like),
    'ad_account', 'account_id', (r) => `act_${r.account_id} · ${r.currency || ''}`);
  push(db.prepare('SELECT * FROM pages WHERE name LIKE ? OR page_id LIKE ? LIMIT 40').all(like, like),
    'page', 'page_id', (r) => r.page_id);
  push(db.prepare('SELECT * FROM pixels WHERE name LIKE ? OR pixel_id LIKE ? LIMIT 40').all(like, like),
    'pixel', 'pixel_id', (r) => r.pixel_id);
  push(db.prepare('SELECT * FROM people WHERE name LIKE ? OR email LIKE ? OR person_id LIKE ? LIMIT 40')
    .all(like, like, like), 'person', 'person_id', (r) => r.email);
  push(db.prepare('SELECT * FROM profiles WHERE name LIKE ? OR fb_user_id LIKE ? LIMIT 40').all(like, like),
    'profile', 'fb_user_id', (r) => r.fb_user_id);
  return out;
}

// profiles that can reach a given business (member edges) — the access answer
function profilesForBusiness(bmId) {
  return db.prepare(
    `SELECT p.*, e.role FROM profiles p JOIN edges e ON e.src_id=p.fb_user_id
     WHERE e.src_type='profile' AND e.dst_type='business' AND e.dst_id=? AND e.relation='member'`)
    .all(bmId).map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
}
// businesses that contain a given asset (owns/client/has edges)
function businessesForAsset(dstType, dstId) {
  return db.prepare(
    `SELECT b.*, e.relation FROM businesses b JOIN edges e ON e.src_id=b.bm_id
     WHERE e.src_type='business' AND e.dst_type=? AND e.dst_id=?`).all(dstType, dstId);
}
// profiles that reach an asset DIRECTLY (not through a BM)
function directProfilesForAsset(dstType, dstId) {
  return db.prepare(
    `SELECT p.* FROM profiles p JOIN edges e ON e.src_id=p.fb_user_id
     WHERE e.src_type='profile' AND e.dst_type=? AND e.dst_id=? AND e.relation='direct'`)
    .all(dstType, dstId).map((p) => ({ ...p, freshness: freshness(p.last_synced_at), relation: 'direct' }));
}
// ad accounts a pixel is shared into (pixel -> ad_account 'shared')
const accountsForPixel = db.prepare(
  `SELECT a.* FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
   WHERE e.src_type='pixel' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`);

/**
 * Reverse lookup: pick any asset -> where it lives + every profile that can reach it.
 * Traverses edges in the right direction per asset type.
 */
function lookup(type, id) {
  const node = {
    business: () => db.prepare('SELECT * FROM businesses WHERE bm_id=?').get(id),
    ad_account: () => db.prepare('SELECT * FROM ad_accounts WHERE account_id=?').get(id),
    page: () => db.prepare('SELECT * FROM pages WHERE page_id=?').get(id),
    pixel: () => db.prepare('SELECT * FROM pixels WHERE pixel_id=?').get(id),
    person: () => db.prepare('SELECT * FROM people WHERE person_id=?').get(id),
    profile: () => db.prepare('SELECT * FROM profiles WHERE fb_user_id=?').get(id),
  }[type];
  if (!node) throw new Error(`unknown type: ${type}`);
  const entity = node();
  if (!entity) return null;

  const res = { type, id, entity, businesses: [], profiles: [], related: [] };

  if (type === 'business') {
    res.businesses = [{ ...entity, relation: 'self' }];
    res.profiles = profilesForBusiness(id);
    res.assets = assetsOfBusiness(id);   // what lives inside this BM (clickable)
  } else if (type === 'ad_account' || type === 'page' || type === 'pixel') {
    res.businesses = businessesForAsset(type, id);
    const seen = new Set();
    const addProf = (p) => { if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); } };
    for (const b of res.businesses) for (const p of profilesForBusiness(b.bm_id)) addProf(p);
    for (const p of directProfilesForAsset(type, id)) addProf(p);   // profiles reaching it directly
    if (type === 'ad_account') res.pixels = pixelsForAccount.all(id);     // pixels assigned to this account
    if (type === 'pixel') res.accounts = accountsForPixel.all(id);        // accounts this pixel is shared into
  } else if (type === 'person') {
    // every business this person has access to, with role — plus reaching profiles
    const rows = db.prepare(
      `SELECT b.*, e.role, e.pending FROM businesses b JOIN edges e ON e.src_id=b.bm_id
       WHERE e.src_type='business' AND e.dst_type='person' AND e.dst_id=?`).all(id);
    res.businesses = rows;
    const seen = new Set();
    for (const b of rows)
      for (const p of profilesForBusiness(b.bm_id))
        if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); }
  } else if (type === 'profile') {
    // BMs this profile is a member of OR reaches (via an asset it can access)
    res.businesses = db.prepare(
      `SELECT b.*, MAX(CASE WHEN e.relation='member' THEN 1 ELSE 0 END) AS is_member
       FROM businesses b JOIN edges e ON e.dst_id=b.bm_id
       WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='business' AND e.relation IN ('member','reaches')
       GROUP BY b.bm_id ORDER BY b.name`).all(id);
    res.profiles = [{ ...entity, freshness: freshness(entity.last_synced_at) }];
    // assets attached directly to this profile (no owning BM at all — truly personal)
    const direct = (t, tbl, k) => db.prepare(
      `SELECT n.* FROM ${tbl} n JOIN edges e ON e.dst_id=n.${k}
       WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='${t}' AND e.relation='direct'
       AND NOT EXISTS (SELECT 1 FROM edges b WHERE b.dst_type='${t}' AND b.dst_id=n.${k} AND b.src_type='business')
       ORDER BY n.name`).all(id);
    res.direct = { ad_accounts: direct('ad_account', 'ad_accounts', 'account_id'),
      pages: direct('page', 'pages', 'page_id'), pixels: direct('pixel', 'pixels', 'pixel_id') };
    res.session = db.prepare('SELECT * FROM sessions WHERE fb_user_id=? ORDER BY checked_at DESC LIMIT 1').get(id);
  }
  return res;
}

// assets contained in a business (for BM drilldown)
function assetsOfBusiness(bmId) {
  return {
    ad_accounts: db.prepare(`SELECT a.*, e.relation FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`).all(bmId),
    pages: db.prepare(`SELECT p.*, e.relation FROM pages p JOIN edges e ON e.dst_id=p.page_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='page' ORDER BY p.name`).all(bmId),
    pixels: db.prepare(`SELECT px.* FROM pixels px JOIN edges e ON e.dst_id=px.pixel_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='pixel' ORDER BY px.name`).all(bmId),
    people: db.prepare(`SELECT pe.*, e.role, e.pending FROM people pe JOIN edges e ON e.dst_id=pe.person_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='person' ORDER BY e.pending, pe.name`).all(bmId),
  };
}

// the Business Manager(s) an asset belongs to — a compact summary for list rows
function bmsOf(dstType, dstId) {
  return db.prepare(`SELECT b.bm_id, b.name, e.relation FROM businesses b JOIN edges e ON e.src_id=b.bm_id
     WHERE e.src_type='business' AND e.dst_type=? AND e.dst_id=?`).all(dstType, dstId);
}
function bmCounts(bmId) {
  const n = (t) => db.prepare(`SELECT COUNT(*) n FROM edges WHERE src_type='business' AND src_id=? AND dst_type=?`).get(bmId, t).n;
  return { ad_accounts: n('ad_account'), pages: n('page'), pixels: n('pixel'), people: n('person') };
}

// Flat, browsable list of every asset of a type (each row links to its detail).
function list(type) {
  if (type === 'ad_account') {
    const pxCount = db.prepare(`SELECT COUNT(*) n FROM edges WHERE src_type='pixel' AND dst_type='ad_account' AND dst_id=?`);
    return db.prepare(`SELECT * FROM ad_accounts ORDER BY CAST(COALESCE(amount_spent,'0') AS INTEGER) DESC`)
      .all().map((a) => ({ ...a, bms: bmsOf('ad_account', a.account_id), pixel_count: pxCount.get(a.account_id).n }));
  }
  if (type === 'pixel')
    return db.prepare('SELECT * FROM pixels ORDER BY name').all().map((p) => ({ ...p,
      bms: bmsOf('pixel', p.pixel_id),
      account_count: db.prepare(`SELECT COUNT(*) n FROM edges WHERE src_type='pixel' AND src_id=? AND dst_type='ad_account'`).get(p.pixel_id).n }));
  if (type === 'page')
    return db.prepare('SELECT * FROM pages ORDER BY name').all().map((p) => ({ ...p, bms: bmsOf('page', p.page_id) }));
  if (type === 'person')
    return db.prepare('SELECT * FROM people ORDER BY name').all().map((p) => ({
      ...p, bms: db.prepare(`SELECT b.bm_id, b.name, e.role, e.pending FROM businesses b JOIN edges e ON e.src_id=b.bm_id
        WHERE e.src_type='business' AND e.dst_type='person' AND e.dst_id=?`).all(p.person_id) }));
  if (type === 'business')
    return db.prepare('SELECT * FROM businesses ORDER BY name').all().map((b) => ({ ...b, counts: bmCounts(b.bm_id) }));
  if (type === 'profile')
    return db.prepare('SELECT * FROM profiles ORDER BY name').all().map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
  return [];
}

function reset() {
  for (const t of ['edges','sweeps','profiles','businesses','ad_accounts','pages','pixels','people','changes','sessions'])
    db.exec(`DELETE FROM ${t}`);
}

// remove one session row (or all with '*') — for dismissing stale/unlabeled entries
function clearSession(label) {
  if (!label || label === '*') { db.exec('DELETE FROM sessions'); return { ok: true, cleared: 'all' }; }
  db.prepare('DELETE FROM sessions WHERE source_label=?').run(label);
  return { ok: true, cleared: label };
}

module.exports = { db, ingest, reportSession, summary, tree, search, lookup, list, changes, sessions, clearSession, reset, freshness, DB_PATH };
