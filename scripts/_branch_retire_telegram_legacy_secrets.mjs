import fs from 'node:fs';

const LEGACY_K = 'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION';
const LEGACY_V = 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION';
const sharedSecrets = [
  'SUPABASE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
];

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function occurrences(text, needle) { return text.split(needle).length - 1; }
function requireCount(text, needle, expected, label) {
  const actual = occurrences(text, needle);
  if (actual !== expected) throw new Error(`${label}: expected ${expected} occurrences of ${needle}, found ${actual}`);
}
function replaceExact(text, from, to, expected, label) {
  requireCount(text, from, expected, label);
  return text.split(from).join(to);
}
function removeStandaloneLines(text, needle, expected, label) {
  requireCount(text, needle, expected, label);
  const lines = text.split('\n');
  const kept = lines.filter((line) => !line.includes(needle));
  return kept.join('\n');
}

// 1. Production preflight: exactly three shared/backend secrets. Legacy Artist
// secrets are no longer a rollback requirement after registry-only acceptance.
{
  const path = 'scripts/preflight-telegram-production.mjs';
  let text = read(path);
  text = removeStandaloneLines(text, LEGACY_K, 2, path);
  text = removeStandaloneLines(text, LEGACY_V, 2, path);
  text = replaceExact(text,
    "\nconst LEGACY_FALLBACK_SECRETS = [\n];\n",
    '\n',
    1,
    path,
  );
  text = replaceExact(text,
    "  for (const name of LEGACY_FALLBACK_SECRETS) {\n    if (!liveSecretNames.includes(name)) {\n      failures.push(`legacy fallback secret ${name} is missing; rollback would have no path`);\n    }\n  }\n",
    '',
    1,
    path,
  );
  const missingBlock = "  const missingSecrets = REQUIRED_SECRET_NAMES.filter((n) => !liveSecretNames.includes(n));\n  if (missingSecrets.length) {\n    failures.push(`required secret names not provisioned: ${missingSecrets.join(', ')}`);\n  }\n";
  const exactBlock = `${missingBlock}  const unexpectedSecrets = liveSecretNames.filter((n) => !REQUIRED_SECRET_NAMES.includes(n));\n  if (unexpectedSecrets.length) {\n    failures.push(\`unexpected production secret names provisioned: \${unexpectedSecrets.join(', ')}\`);\n  }\n`;
  text = replaceExact(text, missingBlock, exactBlock, 1, path);
  for (const secret of sharedSecrets) {
    if (!text.includes(`'${secret}'`)) throw new Error(`${path}: missing required shared secret ${secret}`);
  }
  if (text.includes('LEGACY_FALLBACK_SECRETS')) throw new Error(`${path}: legacy fallback concept still present`);
  write(path, text);
}

// 2. Generated deploy config: only shared/backend secrets are required.
{
  const path = 'scripts/generate-telegram-production-deploy-config.mjs';
  let text = read(path);
  text = removeStandaloneLines(text, LEGACY_K, 1, path);
  text = removeStandaloneLines(text, LEGACY_V, 1, path);
  write(path, text);
}

// 3. Automatic release: both pre- and post-deploy inventories become exact 3.
{
  const path = '.github/workflows/private-production-release.yml';
  let text = read(path);
  text = removeStandaloneLines(text, LEGACY_K, 2, path);
  text = removeStandaloneLines(text, LEGACY_V, 2, path);
  if (text.includes('ARTIST_TELEGRAM_')) throw new Error(`${path}: Artist-specific Telegram secret dependency remains`);
  write(path, text);
}

// 4. Manual emergency Telegram deploy follows the same permanent production
// contract. Linking rollback remains; only the Artist-secret rollback disappears.
{
  const path = '.github/workflows/deploy-private-production-telegram.yml';
  let text = read(path);
  text = removeStandaloneLines(text, LEGACY_K, 1, path);
  text = removeStandaloneLines(text, LEGACY_V, 1, path);
  text = replaceExact(text,
    'legacy_artist_fallback_retained: true',
    'legacy_artist_fallback_retired: true',
    1,
    path,
  );
  text = replaceExact(text,
    'Existing Vladimir/Kristina Artist bindings remain required as the Phase G fallback',
    'Legacy Vladimir/Kristina Artist bindings are retired; production Artist delivery is registry-only',
    1,
    path,
  );
  if (text.includes('ARTIST_TELEGRAM_')) throw new Error(`${path}: Artist-specific Telegram secret dependency remains`);
  write(path, text);
}

// 5. Generator/workflow contract test: legacy names must be absent, not required.
{
  const path = 'scripts/test-telegram-production-config.mjs';
  let text = read(path);
  text = removeStandaloneLines(text, '"ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION"', 1, path);
  text = removeStandaloneLines(text, '"ARTIST_TELEGRAM_KRISTINA_HPRODUCTION"', 1, path);
  const generatedForbidden = "    'GMAIL_TOKEN_ENCRYPTION_KEY',\n    'gwaliusblwrzisrwnsvs',\n";
  text = replaceExact(text, generatedForbidden,
    "    'GMAIL_TOKEN_ENCRYPTION_KEY',\n    'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',\n    'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',\n    'gwaliusblwrzisrwnsvs',\n",
    1,
    path,
  );
  const workflowForbidden = "  'GMAIL_TOKEN_ENCRYPTION_KEY',\n]) expectExcludes(workflow, needle, 'production workflow');";
  text = replaceExact(text, workflowForbidden,
    "  'GMAIL_TOKEN_ENCRYPTION_KEY',\n  'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',\n  'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',\n]) expectExcludes(workflow, needle, 'production workflow');",
    1,
    path,
  );
  write(path, text);
}

// 6. Preflight fixtures now model the retired production state. Extra legacy
// names are explicitly rejected to keep the inventory fail-closed.
{
  const path = 'scripts/test-telegram-production-preflight.mjs';
  let text = read(path);
  const oldMissingLegacy = `{
  const live = {
    ...READY_LIVE,
    secretNames: ['SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION')
    && f.includes('rollback')));
}
`;
  const extraLegacy = `{
  const live = {
    ...READY_LIVE,
    secretNames: [...READY_LIVE.secretNames, 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION'],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('unexpected production secret names')
    && f.includes('ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION')));
}
`;
  text = replaceExact(text, oldMissingLegacy, extraLegacy, 1, path);
  text = removeStandaloneLines(text, LEGACY_K, 2, path);
  // Vladimir appears once in LIVE binding, once in LIVE secretNames, and once in
  // the new negative extra-secret test. Preserve only the negative test.
  const lines = text.split('\n');
  let removedV = 0;
  text = lines.filter((line) => {
    if (!line.includes(LEGACY_V)) return true;
    if (line.includes("secretNames: [...READY_LIVE.secretNames")) return true;
    if (line.includes("f.includes('ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION')")) return true;
    removedV += 1;
    return false;
  }).join('\n');
  if (removedV !== 2) throw new Error(`${path}: expected to remove 2 Vladimir fixture lines, removed ${removedV}`);
  if (occurrences(text, LEGACY_K) !== 0) throw new Error(`${path}: Kristina legacy name remains unexpectedly`);
  if (occurrences(text, LEGACY_V) !== 2) throw new Error(`${path}: expected exactly negative-test Vladimir occurrences`);
  write(path, text);
}

// 7. Release boundary test documents permanent retirement and ensures neither
// production release workflow can accidentally regain Artist-specific secrets.
{
  const path = 'scripts/test-private-production-release-orchestrator.mjs';
  let text = read(path);
  text = replaceExact(text,
    "expectIncludes(telegramRollback, 'legacy_artist_fallback_retained: true', 'Telegram rollback');",
    "expectIncludes(telegramRollback, 'legacy_artist_fallback_retired: true', 'Telegram production retirement');\nexpectExcludes(telegramRollback, 'ARTIST_TELEGRAM_', 'Telegram production retirement');\nexpectExcludes(workflow, 'ARTIST_TELEGRAM_', 'automatic production retirement');",
    1,
    path,
  );
  write(path, text);
}

// Final invariant across production-only contracts. Retained staging runtime is
// intentionally outside this list and keeps its historical fallback tests.
for (const path of [
  'scripts/preflight-telegram-production.mjs',
  'scripts/generate-telegram-production-deploy-config.mjs',
  '.github/workflows/private-production-release.yml',
  '.github/workflows/deploy-private-production-telegram.yml',
]) {
  const text = read(path);
  if (text.includes('ARTIST_TELEGRAM_')) throw new Error(`${path}: legacy Artist production secret remains`);
}

console.log('Bounded Telegram production legacy-secret retirement refactor applied.');
