// Verify the rich-data capture (raw column: tax id, funding, billing address, extended
// credit, instagram, system users) end-to-end on the Postgres path via pglite.
const { PGlite } = require('@electric-sql/pglite');
const store = require('./hub/db.js');
const fs = require('fs');
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
let fail = 0;
const ok = (label, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + (extra || '')}`); if (!cond) fail++; };

(async () => {
  const pg = await PGlite.create();
  const run = (sql, p = []) => pg.query(toPg(sql), p);
  const bind = { all: async (s, p = []) => (await run(s, p)).rows, get: async (s, p = []) => (await run(s, p)).rows[0], run: async (s, p = []) => { await run(s, p); } };
  const driver = { kind: 'pg', autoPk: 'BIGSERIAL PRIMARY KEY', ...bind, exec: async (s) => { await pg.exec(s); },
    tx: async (fn) => { await pg.query('BEGIN'); try { const r = await fn(bind); await pg.query('COMMIT'); return r; } catch (e) { await pg.query('ROLLBACK'); throw e; } } };
  await store.init(driver);

  const rich = JSON.parse(fs.readFileSync('hub/samples/rich.asset-dump.json', 'utf8'));
  const res = await store.ingest(rich, { sourceLabel: rich.sourceLabel });
  ok('ingest ok', res.counts.ad_accounts === 1 && res.counts.businesses === 1, JSON.stringify(res.counts));

  // account raw carries the sensitive/extra fields
  const acc = await store.lookup('ad_account', '700000001');
  const araw = JSON.parse(acc.entity.raw);
  ok('acct funding column', JSON.parse(acc.entity.funding).display_string === 'Mastercard ••5599');
  ok('acct raw tax_id', araw.tax_id === 'US-482913756');
  ok('acct raw billing addr', araw.business_street === '500 5th Ave' && araw.business_zip === '10110');
  ok('acct raw created_time', !!araw.created_time);
  ok('acct raw is_prepay', araw.is_prepay_account === false);

  // business raw carries extended credit / instagram / system users, but NOT the nested asset arrays
  const biz = await store.lookup('business', '178900000009999');
  const braw = JSON.parse(biz.entity.raw);
  ok('bm raw extended_credits', Array.isArray(braw.extended_credits) && braw.extended_credits[0].balance === '1240000');
  ok('bm raw instagram', braw.instagram_accounts[0].username === 'zenithmedia');
  ok('bm raw system_users', braw.system_users[0].role === 'ADMIN');
  ok('bm raw created_time', !!braw.created_time);
  ok('bm raw excludes nested arrays', braw.owned_ad_accounts === undefined && braw.business_users === undefined);

  // pixel + page raw
  const px = await store.lookup('pixel', 'PXR000000001');
  ok('pixel raw data_use_setting', JSON.parse(px.entity.raw).data_use_setting === 'ADVERTISING_AND_ANALYTICS');
  const pg2 = await store.lookup('page', '610000000000001');
  ok('page raw category', JSON.parse(pg2.entity.raw).category === 'Marketing Agency');

  console.log(`\n${fail === 0 ? 'ALL RICH-CAPTURE TESTS PASSED' : fail + ' FAILED'}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('RICH TEST ERROR:', e); process.exit(1); });
