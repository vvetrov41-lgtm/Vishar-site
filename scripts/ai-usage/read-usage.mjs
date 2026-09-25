#!/usr/bin/env node
// Read-only Workers AI usage for this account, from the Cloudflare GraphQL
// Analytics API. Prints aggregates only: date, model, script, counts, token
// and Neuron sums. Never a prompt or a response; the dataset holds none.
//
// The Workers AI dataset is not named in the public docs, so the schema is
// introspected first and the query is built from the fields that exist.
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
const days = Math.min(Math.max(Number(process.env.USAGE_DAYS || 7), 1), 7);

async function gql(query, variables = {}) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    const codes = (body.errors ?? []).map((e) => String(e.message ?? '').slice(0, 160));
    return { error: `http_${response.status}`, messages: codes };
  }
  return { data: body.data };
}

const typeFields = async (name) => {
  const r = await gql(`query($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind } } } } } }`, { n: name });
  return r.data?.__type?.fields ?? [];
};
const baseType = (t) => (t?.ofType?.ofType?.name ?? t?.ofType?.name ?? t?.name);

const accountFields = await typeFields('account');
// Introspection may be unavailable; then try the likely dataset names.
const introspected = accountFields.filter((f) => /^ai/i.test(f.name) && /Groups$/.test(f.name)).map((f) => f.name);
const candidates = introspected.length ? introspected : ['aiInferenceAdaptiveGroups'];
console.log('ai datasets:', JSON.stringify(candidates));
const dataset = candidates.find((n) => /inference/i.test(n)) ?? candidates.find((n) => !/gateway/i.test(n));
if (!dataset) { console.log('no Workers AI dataset is visible to this token'); process.exit(0); }

const groupType = baseType(accountFields.find((f) => f.name === dataset)?.type);
const groupFields = groupType ? await typeFields(groupType) : [];
const dimType = baseType(groupFields.find((f) => f.name === 'dimensions')?.type);
const dims = dimType ? (await typeFields(dimType)).map((f) => f.name) : ['date', 'modelId'];
console.log('group fields:', JSON.stringify(groupFields.map((f) => f.name)));

// Every aggregate object on the group (sum, avg, max, ...) and its numeric
// scalar fields. Neurons may live under any of them.
const aggregates = {};
for (const f of groupFields) {
  if (['dimensions', 'count'].includes(f.name)) continue;
  const t = baseType(f.type);
  const sub = t ? await typeFields(t) : [];
  const numeric = sub.filter((x) => ['Int', 'Float', 'int', 'float', 'uint64', 'float64', 'Long']
    .includes(baseType(x.type)) || /^(u?int|float)/i.test(String(baseType(x.type)))).map((x) => x.name);
  if (numeric.length) aggregates[f.name] = numeric;
}
console.log('aggregates:', JSON.stringify(aggregates));
const sums = Object.entries(aggregates).flatMap(([k, v]) => v.map((n) => `${k}.${n}`));

const wantDims = ['date', 'modelId', 'model', 'scriptName', 'source', 'errorCode', 'statusCode']
  .filter((d) => dims.includes(d));
const dateFilter = dims.includes('date') ? 'date_geq' : 'datetimeHour_geq';
const start = new Date(Date.now() - days * 86400000);
const since = dateFilter === 'date_geq' ? start.toISOString().slice(0, 10) : start.toISOString();

// Cloudflare Analytics scalars are lowercase `string`; dates use `Date`/`Time`.
const query = `query($a: string, $since: ${dateFilter === 'date_geq' ? 'Date' : 'Time'}) { viewer { accounts(filter: { accountTag: $a }) {
  rows: ${dataset}(limit: 1000, filter: { ${dateFilter}: $since }) {
    count
    ${Object.entries(aggregates).map(([k, v]) => `${k} { ${v.join(' ')} }`).join('\n    ')}
    dimensions { ${wantDims.join(' ')} }
  } } } }`;
const result = await gql(query, { a: account, since });
if (result.error) {
  // A refused query is a failed read, never a green run with no data.
  console.log('usage query refused:', result.error, JSON.stringify(result.messages));
  process.exit(1);
}
const rows = result.data?.viewer?.accounts?.[0]?.rows ?? [];
rows.sort((x, y) => String(x.dimensions.date ?? '').localeCompare(String(y.dimensions.date ?? '')));
console.log(`rows: ${rows.length} (last ${days} days)`);
console.log(`| ${wantDims.join(' | ')} | count | ${sums.join(' | ')} |`);
for (const r of rows) {
  console.log(`| ${wantDims.map((d) => r.dimensions[d] ?? '').join(' | ')} | ${r.count} | ${sums.map((path) => { const [k, n] = path.split('.'); return r[k]?.[n] ?? ''; }).join(' | ')} |`);
}
