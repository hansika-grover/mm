// MetaManager hub — database layer.
// Runs on Postgres when DATABASE_URL is set (Render / Neon / any Postgres), and on
// Node's built-in SQLite otherwise (zero-install local dev). Same query logic, one
// small driver shim papering over placeholders (?→$n), autoincrement, and async.
//
// Graph model: assets are NODES keyed on their FB global ID (stored once, deduped),
// access/ownership are EDGES. This is what makes reverse lookup work and scales to
// many profiles/machines (N profiles seeing act_123 = N edges into 1 node).
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const USE_PG = !!process.env.DATABASE_URL;
const num = (v) => (v == null ? 0 : Number(v));   // pg returns COUNT(*) as a string

// ---- driver abstraction ----------------------------------------------------
// Every driver exposes async all/get/run/exec plus tx(fn). Inside tx, fn gets a
// handle with the same all/get/run bound to a single connection (required for pg).
let driver = null;
let DB_PATH = '(uninitialized)';

// convert positional `?` placeholders to Postgres `$1,$2,…`
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

function makeSqliteDriver() {
  const _major = Number(process.versions.node.split('.')[0]);
  if (_major < 22) {
    throw new Error(
      `MetaManager hub on SQLite needs Node >= 22 (built-in node:sqlite). You are on ${process.version}. ` +
      `Upgrade Node, or set DATABASE_URL to use Postgres instead.`);
  }
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  DB_PATH = process.env.FBACC_DB || path.join(DATA_DIR, 'hub.db');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const handle = {
    all: async (sql, p = []) => db.prepare(sql).all(...p),
    get: async (sql, p = []) => db.prepare(sql).get(...p),
    run: async (sql, p = []) => { db.prepare(sql).run(...p); },
  };
  return {
    kind: 'sqlite',
    autoPk: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    ...handle,
    exec: async (sql) => db.exec(sql),
    tx: async (fn) => {
      db.exec('BEGIN');
      try { const r = await fn(handle); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  };
}

async function makePgDriver() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=(localhost|127\.0\.0\.1)/.test(url);
  const ssl = (local || process.env.PGSSL === 'disable') ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, max: 8 });
  DB_PATH = url.replace(/\/\/[^@]*@/, '//***@');   // redact credentials for logging
  const bind = (run) => ({
    all: async (sql, p = []) => (await run(toPg(sql), p)).rows,
    get: async (sql, p = []) => (await run(toPg(sql), p)).rows[0],
    run: async (sql, p = []) => { await run(toPg(sql), p); },
  });
  const base = bind((sql, p) => pool.query(sql, p));
  return {
    kind: 'pg',
    autoPk: 'BIGSERIAL PRIMARY KEY',
    ...base,
    exec: async (sql) => { await pool.query(sql); },
    tx: async (fn) => {
      const client = await pool.connect();
      const h = bind((sql, p) => client.query(sql, p));
      try { await client.query('BEGIN'); const r = await fn(h); await client.query('COMMIT'); return r; }
      catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    },
  };
}

// ---- schema ----------------------------------------------------------------
async function init(overrideDriver) {
  if (driver) return { kind: driver.kind, path: DB_PATH };
  driver = overrideDriver || (USE_PG ? await makePgDriver() : makeSqliteDriver());
  const AUTO = driver.autoPk;

  await driver.exec(`
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
  spend_cap      TEXT,
  currency       TEXT,
  timezone       TEXT,
  funding        TEXT,
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
CREATE TABLE IF NOT EXISTS edges (
  src_type       TEXT NOT NULL,
  src_id         TEXT NOT NULL,
  dst_type       TEXT NOT NULL,
  dst_id         TEXT NOT NULL,
  relation       TEXT NOT NULL,
  role           TEXT,
  pending        INTEGER DEFAULT 0,
  last_synced_at TEXT,
  PRIMARY KEY (src_type, src_id, dst_type, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst_type, dst_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges (src_type, src_id);
CREATE TABLE IF NOT EXISTS sweeps (
  id          ${AUTO},
  profile_id  TEXT,
  profile_name TEXT,
  source_label TEXT,
  fetched_at  TEXT,
  ingested_at TEXT,
  bm_count    INTEGER,
  errors      TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  source_label TEXT PRIMARY KEY,
  fb_user_id   TEXT,
  profile_name TEXT,
  status       TEXT,
  detail       TEXT,
  checked_at   TEXT
);
CREATE TABLE IF NOT EXISTS changes (
  id           ${AUTO},
  at           TEXT,
  profile_id   TEXT,
  profile_name TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  entity_name  TEXT,
  kind         TEXT,
  field        TEXT,
  old_val      TEXT,
  new_val      TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_at ON changes (id DESC);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes (entity_type, entity_id);
`);
  // migrate older SQLite DBs that predate the timezone column (Postgres starts fresh)
  try { await driver.exec('ALTER TABLE ad_accounts ADD COLUMN timezone TEXT'); } catch { /* already present */ }
  // `raw` holds the complete Facebook object for each node, so we keep every field the
  // Graph returns even when there is no dedicated column for it (tax id, billing address,
  // created_time, funding details, extended credit, Instagram, system users, …).
  for (const tbl of ['ad_accounts', 'businesses', 'pages', 'pixels', 'people']) {
    try { await driver.exec(`ALTER TABLE ${tbl} ADD COLUMN raw TEXT`); } catch { /* already present */ }
  }

  return { kind: driver.kind, path: DB_PATH };
}

// ---- upsert SQL ------------------------------------------------------------
const SQL = {
  profile: `INSERT INTO profiles (fb_user_id,name,source_label,first_seen_at,last_synced_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(fb_user_id) DO UPDATE SET name=excluded.name,
      source_label=COALESCE(excluded.source_label,profiles.source_label),
      last_synced_at=excluded.last_synced_at`,
  business: `INSERT INTO businesses (bm_id,name,verification_status,last_synced_at,raw)
    VALUES (?,?,?,?,?)
    ON CONFLICT(bm_id) DO UPDATE SET name=COALESCE(excluded.name,businesses.name),
      verification_status=COALESCE(excluded.verification_status,businesses.verification_status),
      last_synced_at=excluded.last_synced_at, raw=COALESCE(excluded.raw,businesses.raw)`,
  adAccount: `INSERT INTO ad_accounts
    (account_id,name,account_status,disable_reason,balance,amount_spent,spend_cap,currency,timezone,funding,last_synced_at,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET name=excluded.name,account_status=excluded.account_status,
      disable_reason=excluded.disable_reason,balance=excluded.balance,amount_spent=excluded.amount_spent,
      spend_cap=COALESCE(excluded.spend_cap,ad_accounts.spend_cap),currency=excluded.currency,
      timezone=COALESCE(excluded.timezone,ad_accounts.timezone),
      funding=COALESCE(excluded.funding,ad_accounts.funding),last_synced_at=excluded.last_synced_at,
      raw=COALESCE(excluded.raw,ad_accounts.raw)`,
  page: `INSERT INTO pages (page_id,name,verification_status,last_synced_at,raw)
    VALUES (?,?,?,?,?)
    ON CONFLICT(page_id) DO UPDATE SET name=excluded.name,
      verification_status=COALESCE(excluded.verification_status,pages.verification_status),
      last_synced_at=excluded.last_synced_at, raw=COALESCE(excluded.raw,pages.raw)`,
  pixel: `INSERT INTO pixels (pixel_id,name,last_synced_at,raw) VALUES (?,?,?,?)
    ON CONFLICT(pixel_id) DO UPDATE SET name=excluded.name, last_synced_at=excluded.last_synced_at,
      raw=COALESCE(excluded.raw,pixels.raw)`,
  person: `INSERT INTO people (person_id,name,email,last_synced_at,raw) VALUES (?,?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET name=COALESCE(excluded.name,people.name),
      email=COALESCE(excluded.email,people.email), last_synced_at=excluded.last_synced_at,
      raw=COALESCE(excluded.raw,people.raw)`,
  edge: `INSERT INTO edges (src_type,src_id,dst_type,dst_id,relation,role,pending,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(src_type,src_id,dst_type,dst_id,relation) DO UPDATE SET
      role=excluded.role, pending=excluded.pending, last_synced_at=excluded.last_synced_at`,
  sweep: `INSERT INTO sweeps (profile_id,profile_name,source_label,fetched_at,ingested_at,bm_count,errors)
    VALUES (?,?,?,?,?,?,?)`,
  session: `INSERT INTO sessions (source_label,fb_user_id,profile_name,status,detail,checked_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(source_label) DO UPDATE SET fb_user_id=COALESCE(excluded.fb_user_id,sessions.fb_user_id),
      profile_name=COALESCE(excluded.profile_name,sessions.profile_name),
      status=excluded.status, detail=excluded.detail, checked_at=excluded.checked_at`,
  change: `INSERT INTO changes (at,profile_id,profile_name,entity_type,entity_id,entity_name,kind,field,old_val,new_val)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
};

// A Graph list field may come back as {error:"..."} instead of an array (the
// extractor passes FB errors through). Tolerate that everywhere.
const asList = (v) => (Array.isArray(v) ? v : []);
const errOf = (v) => (v && !Array.isArray(v) && v.error ? v.error : null);
// business node fields to keep in `raw`, minus the big nested asset arrays (which each
// become their own rows). Keeps created_time, vertical, extended_credits, system_users,
// instagram_accounts, primary_page, two_factor_type, etc.
const bmRaw = (bm) => {
  const { owned_ad_accounts, client_ad_accounts, owned_pages, client_pages, adspixels,
    business_users, pending_users, ...rest } = bm;
  return JSON.stringify(rest);
};

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
async function ingest(dump, opts = {}) {
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

  await driver.tx(async (t) => {
    // baseline gate: only diff once we've seen this profile before
    const track = !!(await t.get('SELECT 1 FROM profiles WHERE fb_user_id=?', [pid]));
    const change = async (kind, type, id, name, field, oldv, newv) => {
      if (!track) return;
      await t.run(SQL.change, [now, pid, pname, type, String(id), name || null, kind, field || null,
        oldv == null ? null : String(oldv), newv == null ? null : String(newv)]);
      counts.changes++;
    };
    const edgeIsNew = async (st, si, dt, di, rel) =>
      !(await t.get('SELECT 1 FROM edges WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND relation=?', [st, si, dt, di, rel]));

    await t.run(SQL.profile, [pid, pname, label, fetchedAt, fetchedAt]);

    const upsertAcct = async (a) => {
      const id = acctId(a); if (!id) return null;
      const prev = await t.get('SELECT account_status,spend_cap FROM ad_accounts WHERE account_id=?', [id]);
      await t.run(SQL.adAccount, [id, a.name || null, a.account_status ?? null, a.disable_reason ?? null,
        a.balance ?? null, a.amount_spent ?? null, a.adtrust_dsl ?? a.spend_cap ?? null, a.currency ?? null,
        a.timezone_name ?? a.timezone ?? null,
        a.funding_source_details ? JSON.stringify(a.funding_source_details) : null, fetchedAt, JSON.stringify(a)]);
      if (!seen.acct.has(id)) {
        seen.acct.add(id); counts.ad_accounts++;
        if (!prev) await change('added', 'ad_account', id, a.name);
        else if (a.account_status != null && prev.account_status != null && Number(prev.account_status) !== Number(a.account_status))
          await change(Number(a.account_status) === 2 ? 'disabled' : 'status', 'ad_account', id, a.name, 'status', statusLabel(prev.account_status), statusLabel(a.account_status));
        const nc = a.adtrust_dsl ?? a.spend_cap;
        if (prev && nc != null && prev.spend_cap != null && String(prev.spend_cap) !== String(nc))
          await change('cap', 'ad_account', id, a.name, 'spend_limit', prev.spend_cap, nc);
      }
      return id;
    };
    const upsertPage = async (p) => {
      if (!p || !p.id) return null;
      const prev = await t.get('SELECT 1 FROM pages WHERE page_id=?', [p.id]);
      await t.run(SQL.page, [p.id, p.name || null, p.verification_status || null, fetchedAt, JSON.stringify(p)]);
      if (!seen.page.has(p.id)) { seen.page.add(p.id); counts.pages++; if (!prev) await change('added','page',p.id,p.name); }
      return p.id;
    };
    const upsertPixel = async (px) => {
      if (!px || !px.id) return null;
      const prev = await t.get('SELECT 1 FROM pixels WHERE pixel_id=?', [px.id]);
      await t.run(SQL.pixel, [px.id, px.name || null, fetchedAt, JSON.stringify(px)]);
      if (!seen.pixel.has(px.id)) { seen.pixel.add(px.id); counts.pixels++; if (!prev) await change('added','pixel',px.id,px.name); }
      // pixel shared into ad accounts (pixel -> ad_account edge)
      for (const sa of asList(px.shared_accounts || px.assigned_accounts)) {
        const aid = acctId(sa); if (!aid) continue;
        if (sa && sa.name) await t.run(SQL.adAccount, [aid, sa.name, null,null,null,null,null, sa.currency||null, null,null, fetchedAt, null]);
        await t.run(SQL.edge, ['pixel', px.id, 'ad_account', aid, 'shared', null, 0, fetchedAt]); counts.edges++;
      }
      return px.id;
    };
    const addAccess = async (bm, u, pending) => {
      if (!u || !u.id) return;
      await t.run(SQL.person, [u.id, u.name || null, u.email || null, fetchedAt, JSON.stringify(u)]);
      if (!seen.person.has(u.id)) { seen.person.add(u.id); counts.people++; }
      const isNew = await edgeIsNew('business', bm.id, 'person', u.id, 'access');
      await t.run(SQL.edge, ['business', bm.id, 'person', u.id, 'access', u.role || null, pending, fetchedAt]); counts.edges++;
      if (isNew) await change('access', 'person', u.id, u.name || u.email, 'access', null, `${bm.name || bm.id} · ${pending ? 'pending ' : ''}${u.role || 'member'}`);
    };

    for (const bm of asList(dump.businesses)) {
      if (!bm || !bm.id) continue;
      const prevBm = await t.get('SELECT 1 FROM businesses WHERE bm_id=?', [bm.id]);
      await t.run(SQL.business, [bm.id, bm.name || null, bm.verification_status || null, fetchedAt, bmRaw(bm)]);
      if (!seen.bm.has(bm.id)) { seen.bm.add(bm.id); counts.businesses++; if (!prevBm) await change('added','business',bm.id,bm.name); }
      await t.run(SQL.edge, ['profile', pid, 'business', bm.id, 'member', null, 0, fetchedAt]); counts.edges++;

      const acctEdge = async (a, rel) => { const id = await upsertAcct(a); if (id) { await t.run(SQL.edge, ['business', bm.id, 'ad_account', id, rel, null, 0, fetchedAt]); counts.edges++; } };
      const pageEdge = async (p, rel) => { const id = await upsertPage(p); if (id) { await t.run(SQL.edge, ['business', bm.id, 'page', id, rel, null, 0, fetchedAt]); counts.edges++; } };
      for (const a of asList(bm.owned_ad_accounts)) await acctEdge(a, 'owns');
      for (const a of asList(bm.client_ad_accounts)) await acctEdge(a, 'client');
      for (const p of asList(bm.owned_pages)) await pageEdge(p, 'owns');
      for (const p of asList(bm.client_pages)) await pageEdge(p, 'client');
      for (const px of asList(bm.adspixels)) { const id = await upsertPixel(px); if (id) { await t.run(SQL.edge, ['business', bm.id, 'pixel', id, 'has', null, 0, fetchedAt]); counts.edges++; } }
      for (const u of asList(bm.business_users)) await addAccess(bm, u, 0);
      for (const u of asList(bm.pending_users)) await addAccess(bm, u, 1);

      for (const f of ['owned_ad_accounts','client_ad_accounts','owned_pages','client_pages','adspixels','business_users','pending_users']) {
        const e = errOf(bm[f]); if (e) errors.push(`${bm.name || bm.id} · ${f}: ${e}`);
      }
    }

    // profile-level assets from /me/adaccounts etc. An asset's own `business` field is the
    // authoritative BM link: if it has one, the asset lives in that BM (not "direct").
    // "Direct" is reserved for assets with NO owning business at all (truly personal).
    const ownersOf = async (t2, xid) => (await t.all(
      `SELECT DISTINCT src_id FROM edges WHERE dst_type=? AND dst_id=? AND src_type='business'`, [t2, xid])).map((r) => r.src_id);
    const linkProfileAsset = async (t2, xid, biz) => {
      if (biz && biz.id) {
        await t.run(SQL.business, [biz.id, biz.name || null, null, fetchedAt, null]);
        if (!seen.bm.has(biz.id)) { seen.bm.add(biz.id); if (!(await t.get('SELECT 1 FROM businesses WHERE bm_id=?', [biz.id]))) counts.businesses++; }
        await t.run(SQL.edge, ['business', biz.id, t2, xid, 'owns', null, 0, fetchedAt]); counts.edges++;
      }
      const owners = await ownersOf(t2, xid);
      if (owners.length) {
        // the profile reaches this asset through its BM(s), so surface those BMs in the profile.
        // Also drop any stale "direct" edge from an older sync (before we knew the BM).
        await t.run(`DELETE FROM edges WHERE src_type='profile' AND src_id=? AND dst_type=? AND dst_id=? AND relation='direct'`, [pid, t2, xid]);
        for (const b of owners) { await t.run(SQL.edge, ['profile', pid, 'business', b, 'reaches', null, 0, fetchedAt]); counts.edges++; }
      } else {
        await t.run(SQL.edge, ['profile', pid, t2, xid, 'direct', null, 0, fetchedAt]); counts.edges++;
      }
    };
    for (const a of asList(dump.me_ad_accounts || dump.direct_ad_accounts)) { const id = await upsertAcct(a); if (id) await linkProfileAsset('ad_account', id, a.business); }
    for (const p of asList(dump.me_pages || dump.direct_pages)) { const id = await upsertPage(p); if (id) await linkProfileAsset('page', id, p.business); }
    for (const px of asList(dump.me_pixels || dump.direct_pixels)) { const id = await upsertPixel(px); if (id) await linkProfileAsset('pixel', id, px.business || (px.owner_business)); }

    await t.run(SQL.sweep, [pid, pname, label, fetchedAt, now, counts.businesses, errors.length ? JSON.stringify(errors) : null]);
    if (label || pid) await t.run(SQL.session, [label || pid, pid, pname, 'ok', null, now]);
  });

  return { profile: { id: pid, name: pname }, fetchedAt, counts, errors };
}

// Extension calls this when it could NOT extract (logged out / no token) so the
// dashboard can flag the profile/session instead of showing stale data as fine.
async function reportSession(s) {
  const label = s.source_label || s.sourceLabel || s.fb_user_id;
  if (!label) throw new Error('source_label or fb_user_id required');
  await driver.run(SQL.session, [label, s.fb_user_id || null, s.profile_name || null,
    s.status || 'error', s.detail || null, new Date().toISOString()]);
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
async function summary() {
  const one = async (sql) => num((await driver.get(sql)).n);
  const profiles = (await driver.all('SELECT * FROM profiles ORDER BY name'))
    .map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
  const sweeps = (await driver.all('SELECT * FROM sweeps ORDER BY id DESC LIMIT 25'))
    .map((s) => ({ ...s, errors: s.errors ? JSON.parse(s.errors) : [] }));
  const statusRows = (await driver.all(
    'SELECT account_status AS s, COUNT(*) AS n FROM ad_accounts GROUP BY account_status ORDER BY account_status'))
    .map((r) => ({ s: r.s, n: num(r.n) }));
  return {
    counts: {
      profiles: await one('SELECT COUNT(*) n FROM profiles'),
      businesses: await one('SELECT COUNT(*) n FROM businesses'),
      ad_accounts: await one('SELECT COUNT(*) n FROM ad_accounts'),
      pages: await one('SELECT COUNT(*) n FROM pages'),
      pixels: await one('SELECT COUNT(*) n FROM pixels'),
      people: await one('SELECT COUNT(*) n FROM people'),
    },
    adStatus: statusRows,
    profiles,
    sweeps,
    sessions: await sessions(),
    changesCount: await one('SELECT COUNT(*) n FROM changes'),
    recentChanges: await changes(8),
  };
}

// login/session status per browser-session (source label)
async function sessions() {
  return (await driver.all('SELECT * FROM sessions ORDER BY checked_at DESC')).map((s) => ({
    ...s, freshness: freshness(s.checked_at),
  }));
}

// change log (newest first)
async function changes(limit = 100, entity) {
  if (entity && entity.type && entity.id)
    return driver.all('SELECT * FROM changes WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT ?', [entity.type, String(entity.id), limit]);
  return driver.all('SELECT * FROM changes ORDER BY id DESC LIMIT ?', [limit]);
}

// pixels shared into a given ad account (pixel -> ad_account 'shared' edge)
const PIXELS_FOR_ACCOUNT =
  `SELECT px.* FROM pixels px JOIN edges e ON e.src_id=px.pixel_id
   WHERE e.src_type='pixel' AND e.dst_type='ad_account' AND e.dst_id=? ORDER BY px.name`;
const withPixels = async (a) => ({ ...a, pixels: await driver.all(PIXELS_FOR_ACCOUNT, [a.account_id]) });

// Full tree: profile -> businesses -> {ad accounts (+their pixels), pages, pixels, people}
//            plus profile-direct assets that live outside any BM.
async function tree() {
  const profiles = await driver.all('SELECT * FROM profiles ORDER BY name');
  const bmsForProfile = (id) => driver.all(
    `SELECT b.*, MAX(CASE WHEN e.relation='member' THEN 1 ELSE 0 END) AS is_member
     FROM businesses b JOIN edges e ON e.dst_id=b.bm_id
     WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='business' AND e.relation IN ('member','reaches')
     GROUP BY b.bm_id ORDER BY b.name`, [id]);
  const acctsForBm = (id) => driver.all(
    `SELECT a.*, e.relation FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`, [id]);
  const pagesForBm = (id) => driver.all(
    `SELECT p.*, e.relation FROM pages p JOIN edges e ON e.dst_id=p.page_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='page' ORDER BY p.name`, [id]);
  const pixForBm = (id) => driver.all(
    `SELECT px.* FROM pixels px JOIN edges e ON e.dst_id=px.pixel_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='pixel' ORDER BY px.name`, [id]);
  const peopleForBm = (id) => driver.all(
    `SELECT pe.*, e.role, e.pending FROM people pe JOIN edges e ON e.dst_id=pe.person_id
     WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='person' ORDER BY e.pending, pe.name`, [id]);
  // "direct" = profile reaches it AND no business owns it (truly personal)
  const directAssets = (t, tbl, k, id) => driver.all(
    `SELECT n.* FROM ${tbl} n JOIN edges e ON e.dst_id=n.${k}
     WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='${t}' AND e.relation='direct'
     AND NOT EXISTS (SELECT 1 FROM edges b WHERE b.dst_type='${t}' AND b.dst_id=n.${k} AND b.src_type='business')
     ORDER BY n.name`, [id]);

  const out = [];
  for (const p of profiles) {
    const bms = await bmsForProfile(p.fb_user_id);
    const businesses = [];
    for (const b of bms) {
      const accts = await acctsForBm(b.bm_id);
      businesses.push({
        ...b,
        ad_accounts: await Promise.all(accts.map(withPixels)),
        pages: await pagesForBm(b.bm_id),
        pixels: await pixForBm(b.bm_id),
        people: await peopleForBm(b.bm_id),
      });
    }
    const directAccts = await directAssets('ad_account', 'ad_accounts', 'account_id', p.fb_user_id);
    const direct = {
      ad_accounts: await Promise.all(directAccts.map(withPixels)),
      pages: await directAssets('page', 'pages', 'page_id', p.fb_user_id),
      pixels: await directAssets('pixel', 'pixels', 'pixel_id', p.fb_user_id),
    };
    out.push({ ...p, freshness: freshness(p.last_synced_at), businesses, direct });
  }
  return out;
}

async function search(q) {
  if (!q || !q.trim()) return [];
  const like = `%${q.trim()}%`;
  const out = [];
  const push = (rows, type, idKey, sub) =>
    rows.forEach((r) => out.push({ type, id: r[idKey], name: r.name, sub: sub(r) }));
  push(await driver.all('SELECT * FROM businesses WHERE name LIKE ? OR bm_id LIKE ? LIMIT 40', [like, like]),
    'business', 'bm_id', (r) => r.verification_status);
  push(await driver.all('SELECT * FROM ad_accounts WHERE name LIKE ? OR account_id LIKE ? LIMIT 40', [like, like]),
    'ad_account', 'account_id', (r) => `act_${r.account_id} · ${r.currency || ''}`);
  push(await driver.all('SELECT * FROM pages WHERE name LIKE ? OR page_id LIKE ? LIMIT 40', [like, like]),
    'page', 'page_id', (r) => r.page_id);
  push(await driver.all('SELECT * FROM pixels WHERE name LIKE ? OR pixel_id LIKE ? LIMIT 40', [like, like]),
    'pixel', 'pixel_id', (r) => r.pixel_id);
  push(await driver.all('SELECT * FROM people WHERE name LIKE ? OR email LIKE ? OR person_id LIKE ? LIMIT 40',
    [like, like, like]), 'person', 'person_id', (r) => r.email);
  push(await driver.all('SELECT * FROM profiles WHERE name LIKE ? OR fb_user_id LIKE ? LIMIT 40', [like, like]),
    'profile', 'fb_user_id', (r) => r.fb_user_id);
  return out;
}

// profiles that can reach a given business (member edges) — the access answer
async function profilesForBusiness(bmId) {
  return (await driver.all(
    `SELECT p.*, e.role FROM profiles p JOIN edges e ON e.src_id=p.fb_user_id
     WHERE e.src_type='profile' AND e.dst_type='business' AND e.dst_id=? AND e.relation='member'`, [bmId]))
    .map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
}
// businesses that contain a given asset (owns/client/has edges)
function businessesForAsset(dstType, dstId) {
  return driver.all(
    `SELECT b.*, e.relation FROM businesses b JOIN edges e ON e.src_id=b.bm_id
     WHERE e.src_type='business' AND e.dst_type=? AND e.dst_id=?`, [dstType, dstId]);
}
// profiles that reach an asset DIRECTLY (not through a BM)
async function directProfilesForAsset(dstType, dstId) {
  return (await driver.all(
    `SELECT p.* FROM profiles p JOIN edges e ON e.src_id=p.fb_user_id
     WHERE e.src_type='profile' AND e.dst_type=? AND e.dst_id=? AND e.relation='direct'`, [dstType, dstId]))
    .map((p) => ({ ...p, freshness: freshness(p.last_synced_at), relation: 'direct' }));
}
// ad accounts a pixel is shared into (pixel -> ad_account 'shared')
const ACCOUNTS_FOR_PIXEL =
  `SELECT a.* FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
   WHERE e.src_type='pixel' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`;

/**
 * Reverse lookup: pick any asset -> where it lives + every profile that can reach it.
 */
async function lookup(type, id) {
  const nodes = {
    business: () => driver.get('SELECT * FROM businesses WHERE bm_id=?', [id]),
    ad_account: () => driver.get('SELECT * FROM ad_accounts WHERE account_id=?', [id]),
    page: () => driver.get('SELECT * FROM pages WHERE page_id=?', [id]),
    pixel: () => driver.get('SELECT * FROM pixels WHERE pixel_id=?', [id]),
    person: () => driver.get('SELECT * FROM people WHERE person_id=?', [id]),
    profile: () => driver.get('SELECT * FROM profiles WHERE fb_user_id=?', [id]),
  };
  if (!nodes[type]) throw new Error(`unknown type: ${type}`);
  const entity = await nodes[type]();
  if (!entity) return null;

  const res = { type, id, entity, businesses: [], profiles: [], related: [] };

  if (type === 'business') {
    res.businesses = [{ ...entity, relation: 'self' }];
    res.profiles = await profilesForBusiness(id);
    res.assets = await assetsOfBusiness(id);   // what lives inside this BM (clickable)
  } else if (type === 'ad_account' || type === 'page' || type === 'pixel') {
    res.businesses = await businessesForAsset(type, id);
    const seen = new Set();
    const addProf = (p) => { if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); } };
    for (const b of res.businesses) for (const p of await profilesForBusiness(b.bm_id)) addProf(p);
    for (const p of await directProfilesForAsset(type, id)) addProf(p);
    if (type === 'ad_account') res.pixels = await driver.all(PIXELS_FOR_ACCOUNT, [id]);
    if (type === 'pixel') res.accounts = await driver.all(ACCOUNTS_FOR_PIXEL, [id]);
  } else if (type === 'person') {
    const rows = await driver.all(
      `SELECT b.*, e.role, e.pending FROM businesses b JOIN edges e ON e.src_id=b.bm_id
       WHERE e.src_type='business' AND e.dst_type='person' AND e.dst_id=?`, [id]);
    res.businesses = rows;
    const seen = new Set();
    for (const b of rows)
      for (const p of await profilesForBusiness(b.bm_id))
        if (!seen.has(p.fb_user_id)) { seen.add(p.fb_user_id); res.profiles.push(p); }
  } else if (type === 'profile') {
    res.businesses = await driver.all(
      `SELECT b.*, MAX(CASE WHEN e.relation='member' THEN 1 ELSE 0 END) AS is_member
       FROM businesses b JOIN edges e ON e.dst_id=b.bm_id
       WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='business' AND e.relation IN ('member','reaches')
       GROUP BY b.bm_id ORDER BY b.name`, [id]);
    res.profiles = [{ ...entity, freshness: freshness(entity.last_synced_at) }];
    const direct = (t, tbl, k) => driver.all(
      `SELECT n.* FROM ${tbl} n JOIN edges e ON e.dst_id=n.${k}
       WHERE e.src_type='profile' AND e.src_id=? AND e.dst_type='${t}' AND e.relation='direct'
       AND NOT EXISTS (SELECT 1 FROM edges b WHERE b.dst_type='${t}' AND b.dst_id=n.${k} AND b.src_type='business')
       ORDER BY n.name`, [id]);
    res.direct = { ad_accounts: await direct('ad_account', 'ad_accounts', 'account_id'),
      pages: await direct('page', 'pages', 'page_id'), pixels: await direct('pixel', 'pixels', 'pixel_id') };
    res.session = await driver.get('SELECT * FROM sessions WHERE fb_user_id=? ORDER BY checked_at DESC LIMIT 1', [id]);
  }
  return res;
}

// assets contained in a business (for BM drilldown)
async function assetsOfBusiness(bmId) {
  return {
    ad_accounts: await driver.all(`SELECT a.*, e.relation FROM ad_accounts a JOIN edges e ON e.dst_id=a.account_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='ad_account' ORDER BY a.name`, [bmId]),
    pages: await driver.all(`SELECT p.*, e.relation FROM pages p JOIN edges e ON e.dst_id=p.page_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='page' ORDER BY p.name`, [bmId]),
    pixels: await driver.all(`SELECT px.* FROM pixels px JOIN edges e ON e.dst_id=px.pixel_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='pixel' ORDER BY px.name`, [bmId]),
    people: await driver.all(`SELECT pe.*, e.role, e.pending FROM people pe JOIN edges e ON e.dst_id=pe.person_id
       WHERE e.src_type='business' AND e.src_id=? AND e.dst_type='person' ORDER BY e.pending, pe.name`, [bmId]),
  };
}

// the Business Manager(s) an asset belongs to — a compact summary for list rows
function bmsOf(dstType, dstId) {
  return driver.all(`SELECT b.bm_id, b.name, e.relation FROM businesses b JOIN edges e ON e.src_id=b.bm_id
     WHERE e.src_type='business' AND e.dst_type=? AND e.dst_id=?`, [dstType, dstId]);
}
async function bmCounts(bmId) {
  const n = async (t) => num((await driver.get(`SELECT COUNT(*) n FROM edges WHERE src_type='business' AND src_id=? AND dst_type=?`, [bmId, t])).n);
  return { ad_accounts: await n('ad_account'), pages: await n('page'), pixels: await n('pixel'), people: await n('person') };
}

// Flat, browsable list of every asset of a type (each row links to its detail).
async function list(type) {
  if (type === 'ad_account') {
    const rows = await driver.all(`SELECT * FROM ad_accounts ORDER BY CAST(COALESCE(NULLIF(amount_spent,''),'0') AS BIGINT) DESC`);
    const out = [];
    for (const a of rows) {
      const pc = num((await driver.get(`SELECT COUNT(*) n FROM edges WHERE src_type='pixel' AND dst_type='ad_account' AND dst_id=?`, [a.account_id])).n);
      out.push({ ...a, bms: await bmsOf('ad_account', a.account_id), pixel_count: pc });
    }
    return out;
  }
  if (type === 'pixel') {
    const rows = await driver.all('SELECT * FROM pixels ORDER BY name');
    const out = [];
    for (const p of rows) {
      const ac = num((await driver.get(`SELECT COUNT(*) n FROM edges WHERE src_type='pixel' AND src_id=? AND dst_type='ad_account'`, [p.pixel_id])).n);
      out.push({ ...p, bms: await bmsOf('pixel', p.pixel_id), account_count: ac });
    }
    return out;
  }
  if (type === 'page') {
    const rows = await driver.all('SELECT * FROM pages ORDER BY name');
    return Promise.all(rows.map(async (p) => ({ ...p, bms: await bmsOf('page', p.page_id) })));
  }
  if (type === 'person') {
    const rows = await driver.all('SELECT * FROM people ORDER BY name');
    return Promise.all(rows.map(async (p) => ({
      ...p, bms: await driver.all(`SELECT b.bm_id, b.name, e.role, e.pending FROM businesses b JOIN edges e ON e.src_id=b.bm_id
        WHERE e.src_type='business' AND e.dst_type='person' AND e.dst_id=?`, [p.person_id]) })));
  }
  if (type === 'business') {
    const rows = await driver.all('SELECT * FROM businesses ORDER BY name');
    return Promise.all(rows.map(async (b) => ({ ...b, counts: await bmCounts(b.bm_id) })));
  }
  if (type === 'profile')
    return (await driver.all('SELECT * FROM profiles ORDER BY name')).map((p) => ({ ...p, freshness: freshness(p.last_synced_at) }));
  return [];
}

async function reset() {
  for (const t of ['edges','sweeps','profiles','businesses','ad_accounts','pages','pixels','people','changes','sessions'])
    await driver.exec(`DELETE FROM ${t}`);
}

// remove one session row (or all with '*') — for dismissing stale/unlabeled entries
async function clearSession(label) {
  if (!label || label === '*') { await driver.exec('DELETE FROM sessions'); return { ok: true, cleared: 'all' }; }
  await driver.run('DELETE FROM sessions WHERE source_label=?', [label]);
  return { ok: true, cleared: label };
}

module.exports = { init, ingest, reportSession, summary, tree, search, lookup, list, changes, sessions, clearSession, reset, freshness,
  get DB_PATH() { return DB_PATH; } };
