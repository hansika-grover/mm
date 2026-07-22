// Validate the Postgres path of hub/db.js against real Postgres semantics (pglite,
// embedded WASM Postgres) — no server needed. Runs the exact db.js logic through a
// pg-shaped driver and checks the results match the known SQLite run.
const { PGlite } = require('@electric-sql/pglite');
const store = require('./hub/db.js');
const fs = require('fs');

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  if (!ok) fail++;
};

(async () => {
  const pg = await PGlite.create();
  const run = (sql, p = []) => pg.query(toPg(sql), p);
  const bind = {
    all: async (sql, p = []) => (await run(sql, p)).rows,
    get: async (sql, p = []) => (await run(sql, p)).rows[0],
    run: async (sql, p = []) => { await run(sql, p); },
  };
  const driver = {
    kind: 'pg', autoPk: 'BIGSERIAL PRIMARY KEY', ...bind,
    exec: async (sql) => { await pg.exec(sql); },
    tx: async (fn) => {
      await pg.query('BEGIN');
      try { const r = await fn(bind); await pg.query('COMMIT'); return r; }
      catch (e) { await pg.query('ROLLBACK'); throw e; }
    },
  };

  const info = await store.init(driver);
  console.log('driver:', info.kind, '\n');

  const s1 = JSON.parse(fs.readFileSync('hub/samples/profile1.asset-dump.json', 'utf8'));
  const s2 = JSON.parse(fs.readFileSync('hub/samples/profile2.asset-dump.json', 'utf8'));

  const r1 = await store.ingest(s1, { sourceLabel: s1.sourceLabel });
  eq('ingest1 counts', r1.counts, { businesses: 2, ad_accounts: 4, pages: 2, pixels: 1, people: 3, edges: 13, changes: 0 });
  const r2 = await store.ingest(s2, { sourceLabel: s2.sourceLabel });
  eq('ingest2 counts', r2.counts, { businesses: 2, ad_accounts: 2, pages: 1, pixels: 2, people: 1, edges: 9, changes: 0 });

  const sum = await store.summary();
  eq('summary counts', sum.counts, { profiles: 2, businesses: 3, ad_accounts: 5, pages: 2, pixels: 2, people: 4 });
  eq('adStatus', sum.adStatus, [{ s: 1, n: 3 }, { s: 2, n: 1 }, { s: 9, n: 1 }]);
  eq('changesCount is number', typeof sum.changesCount, 'number');

  const la = await store.list('ad_account');
  eq('ad_account list len', la.length, 5);
  eq('top by spend (CAST ordering)', la[0].name, 'Nova — Scale');
  eq('funding present on owned acct', la.find((a) => a.funding)?.name, 'Acme — US Prospecting');
  eq('pixel_count is number', typeof la[0].pixel_count, 'number');

  const tr = await store.tree();
  eq('tree profiles', tr.length, 2);
  eq('p0 businesses', tr.find((p) => p.fb_user_id === '100011112223334').businesses.length, 2);

  const lk = await store.lookup('ad_account', '500000001');
  eq('lookup entity', lk.entity.name, 'Acme — US Prospecting');
  eq('lookup profiles', lk.profiles.length, 2);
  eq('lookup businesses', lk.businesses.length, 1);

  const bl = await store.list('business');
  eq('business counts are numbers', typeof bl[0].counts.ad_accounts, 'number');

  const r3 = await store.ingest(s1, { sourceLabel: s1.sourceLabel });
  eq('re-ingest identical -> 0 changes', r3.counts.changes, 0);

  // mutate an account status and re-ingest -> should detect a change
  const s1b = JSON.parse(JSON.stringify(s1));
  s1b.businesses[0].owned_ad_accounts[0].account_status = 2; // active -> disabled
  const r4 = await store.ingest(s1b, { sourceLabel: s1.sourceLabel });
  eq('status flip -> >=1 change', r4.counts.changes >= 1, true);

  console.log(`\n${fail === 0 ? 'ALL PG TESTS PASSED' : fail + ' PG TESTS FAILED'}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('PG TEST ERROR:', e); process.exit(1); });
