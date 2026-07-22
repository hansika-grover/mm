// MetaManager reader — run in the console of a logged-in business.facebook.com tab.
// READ-ONLY. Reads the whole asset tree in one pass, downloads asset-dump.json.
(async () => {
  const V = 'v19.0';
  const html = document.documentElement.innerHTML;
  const tok = (html.match(/"(EA[A-Za-z0-9]{20,})/) || [])[1];
  if (!tok) return alert('No access token found on this page — open Ads/Business Manager and retry.');
  const g = async (path, fields) => {
    const u = `https://graph.facebook.com/${V}/${path}?access_token=${tok}` +
              (fields ? `&fields=${fields}` : '') + `&limit=200`;
    const r = await fetch(u, { credentials: 'include' });
    const j = await r.json();
    return j.error ? { error: j.error.message } : (j.data ?? j);
  };
  const me = await g('me', 'id,name');
  const bms = await g('me/businesses', 'id,name,verification_status');
  const out = { me, fetchedAt: new Date().toISOString(), businesses: [] };
  for (const bm of (bms || [])) {
    const [owned, client, pages, cpages, pixels, users, pending] = await Promise.all([
      g(`${bm.id}/owned_ad_accounts`, 'account_id,name,account_status,disable_reason,balance,amount_spent,adtrust_dsl,currency,funding_source_details'),
      g(`${bm.id}/client_ad_accounts`, 'account_id,name,account_status,disable_reason,balance,amount_spent,currency'),
      g(`${bm.id}/owned_pages`, 'id,name,verification_status'),
      g(`${bm.id}/client_pages`, 'id,name'),
      g(`${bm.id}/adspixels`, 'id,name'),
      g(`${bm.id}/business_users`, 'id,name,email,role'),
      g(`${bm.id}/pending_users`, 'id,email,role'),
    ]);
    out.businesses.push({ ...bm, owned_ad_accounts: owned, client_ad_accounts: client,
      owned_pages: pages, client_pages: cpages, adspixels: pixels,
      business_users: users, pending_users: pending });
  }
  console.log(out);
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'asset-dump.json'; a.click();
  alert(`Done: ${out.businesses.length} Business Managers dumped to asset-dump.json`);
})();
