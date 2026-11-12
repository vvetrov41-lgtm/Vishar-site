// Fail-closed source-of-truth check for the one-time DeepSeek env-var cleanup.
// Reads only Cloudflare binding metadata; never prints values or secret payloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function trackedVars(toml) {
  const marker = /^\[vars\]\s*$/m.exec(toml);
  if (!marker) throw new Error('TattooAI production [vars] section missing');
  const rest = toml.slice(marker.index + marker[0].length);
  const next = /^\[[^\]\n]+\]\s*$/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const values = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*")\s*$/.exec(line);
    if (!match) throw new Error('Unrecognized TattooAI production variable declaration');
    if (values.has(match[1])) throw new Error('Duplicate TattooAI variable: ' + match[1]);
    const value = JSON.parse(match[2]);
    if (typeof value !== 'string') throw new Error('Non-string TattooAI variable: ' + match[1]);
    values.set(match[1], value);
  }
  if (values.size < 30 || values.get('VISHAR_ENVIRONMENT') !== 'production'
    || values.get('CRM_AGENT_ENABLED') !== 'true'
    || values.get('CRM_AI_INTAKE_ENABLED') !== 'false'
    || values.get('OUTGOING_AI_REVIEW_ENABLED') !== 'true'
    || values.has('AI_MODEL_DEEPSEEK_TEXT')) {
    throw new Error('TattooAI tracked variable contract changed');
  }
  return values;
}

function bindingsFrom(snapshot) {
  if (!snapshot || snapshot.success !== true || !Array.isArray(snapshot.result?.bindings)) {
    throw new Error('Cloudflare Worker settings unavailable');
  }
  const seen = new Set();
  for (const item of snapshot.result.bindings) {
    if (!item || typeof item.name !== 'string' || typeof item.type !== 'string'
      || seen.has(item.name)) throw new Error('Cloudflare binding inventory invalid');
    seen.add(item.name);
  }
  if (!snapshot.result.bindings.some(item => item.name === 'AI' && item.type === 'ai')) {
    throw new Error('Workers AI binding missing');
  }
  return snapshot.result.bindings;
}

export function verifySnapshot(snapshot, tracked, { allowLegacyDeepseek = false, before = null } = {}) {
  const bindings = bindingsFrom(snapshot);
  const remote = new Map(bindings.filter(item => item.type === 'plain_text')
    .map(item => [item.name, item.text]));
  for (const [name, value] of tracked) {
    if (!remote.has(name)) throw new Error('Tracked Cloudflare variable missing: ' + name);
    if (remote.get(name) !== value) throw new Error('Tracked Cloudflare variable drift: ' + name);
  }
  const remoteOnly = [...remote.keys()].filter(name => !tracked.has(name)).sort();
  if (!(remoteOnly.length === 0
    || (allowLegacyDeepseek && remoteOnly.length === 1 && remoteOnly[0] === 'AI_MODEL_DEEPSEEK_TEXT'))) {
    throw new Error('Unexpected Cloudflare variable inventory: ' + remoteOnly.join(','));
  }
  if (before) {
    const types = items => items.filter(item => item.type !== 'plain_text')
      .map(item => item.type + ':' + item.name).sort();
    assert.deepEqual(types(bindings), types(bindingsFrom(before)),
      'Non-plaintext bindings (including secrets) must remain unchanged');
  }
  return { trackedVariables: tracked.size, legacyVariablePresent: remoteOnly.length === 1 };
}

function selfTest() {
  const vars = trackedVars(fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'));
  const base = { success: true, result: { bindings: [
    { name: 'AI', type: 'ai' },
    { name: 'SERVICE_KEY', type: 'secret_text' },
    ...[...vars].map(([name, text]) => ({ name, text, type: 'plain_text' })),
  ] } };
  assert.equal(verifySnapshot(base, vars).legacyVariablePresent, false);
  const legacy = structuredClone(base);
  legacy.result.bindings.push({ name: 'AI_MODEL_DEEPSEEK_TEXT', text: 'retired', type: 'plain_text' });
  assert.equal(verifySnapshot(legacy, vars, { allowLegacyDeepseek: true }).legacyVariablePresent, true);
  assert.throws(() => verifySnapshot(legacy, vars), /Unexpected Cloudflare/);
  const drift = structuredClone(base);
  drift.result.bindings.find(item => item.name === 'CRM_AI_INTAKE_ENABLED').text = 'true';
  assert.throws(() => verifySnapshot(drift, vars), /drift/);
  const missing = structuredClone(base);
  missing.result.bindings = missing.result.bindings.filter(item => item.name !== 'AI');
  assert.throws(() => verifySnapshot(missing, vars), /Workers AI binding missing/);
  const extra = structuredClone(base);
  extra.result.bindings.push({ name: 'NOT_TRACKED', type: 'plain_text', text: 'unexpected' });
  assert.throws(() => verifySnapshot(extra, vars, { allowLegacyDeepseek: true }), /Unexpected Cloudflare/);
  const secretLoss = structuredClone(base);
  secretLoss.result.bindings = secretLoss.result.bindings.filter(item => item.name !== 'SERVICE_KEY');
  assert.throws(() => verifySnapshot(secretLoss, vars, { before: base }), /Non-plaintext bindings/);
  console.log('TattooAI variable reconciliation self-test: 7 safety checks passed.');
}

const argv = process.argv.slice(2);
if (argv[0] === '--self-test') {
  selfTest();
} else if (argv[0] === '--check') {
  const file = argv[1];
  if (!file) throw new Error('Cloudflare settings snapshot path is required');
  const beforeAt = argv.indexOf('--compare-before');
  const before = beforeAt >= 0
    ? JSON.parse(fs.readFileSync(argv[beforeAt + 1], 'utf8')) : null;
  const tracked = trackedVars(fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'));
  const result = verifySnapshot(JSON.parse(fs.readFileSync(file, 'utf8')), tracked, {
    allowLegacyDeepseek: argv.includes('--allow-legacy-deepseek'),
    before,
  });
  console.log('Cloudflare AI bindings verified: ' + result.trackedVariables
    + ' tracked variables; DeepSeek orphan ' + (result.legacyVariablePresent ? 'present before cleanup' : 'absent') + '.');
} else {
  throw new Error('Usage: --self-test or --check settings.json [--allow-legacy-deepseek] [--compare-before before.json]');
}
