import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import registry from '../config/discovery-sources.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'supabase', 'migrations');

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sqlQuotedValues(group) {
  return [...group.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function assertRegistryShape() {
  assert.equal(registry.version, 1);
  assert.ok(Array.isArray(registry.sources));
  assert.ok(registry.sources.length > 0);

  const keys = registry.sources.map((source) => source.key);
  assert.equal(new Set(keys).size, keys.length, 'discovery source keys must be unique');

  for (const source of registry.sources) {
    assert.match(source.key, /^[a-z][a-z0-9_]*$/);
    assert.ok(source.labels?.en);
    assert.ok(source.labels?.ru);
    assert.ok(['none', 'optional', 'required'].includes(source.detail?.mode));
    if (source.detail.mode === 'none') {
      assert.equal(source.detail.label_en, '');
      assert.equal(source.detail.label_ru, '');
    } else {
      assert.ok(source.detail.label_en);
      assert.ok(source.detail.label_ru);
    }
  }

  for (const [alias, target] of Object.entries(registry.legacyAliases)) {
    assert.ok(alias);
    assert.ok(keys.includes(target), `legacy alias ${alias} points to unknown key ${target}`);
    assert.ok(!keys.includes(alias), `legacy alias ${alias} must not be a canonical key`);
  }
}

async function latestDatabaseDiscoveryKeys() {
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  let latest = null;

  const pattern = /add constraint enquiries_discovery_source_known[\s\S]*?check\s*\(\s*discovery_source is null\s*or\s*discovery_source in\s*\(([^)]*)\)/gi;
  for (const file of files) {
    const sql = await readFile(path.join(migrationDir, file), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      latest = { file, keys: sqlQuotedValues(match[1]) };
    }
  }

  assert.ok(latest, 'could not find the final enquiries_discovery_source_known constraint');
  return latest;
}

async function latestAiDiscoveryKeys() {
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  let latest = null;

  const pattern = /v_key\s*=\s*'discovery_source'[\s\S]{0,260}?not in\s*\(([^)]*)\)/gi;
  for (const file of files) {
    const sql = await readFile(path.join(migrationDir, file), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      latest = { file, keys: sqlQuotedValues(match[1]) };
    }
  }

  assert.ok(latest, 'could not find the final AI discovery_source validator contract');
  return latest;
}

function parseOptionAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

async function personalFormSources() {
  const html = await readFile(path.join(root, 'booking', 'index.html'), 'utf8');
  const select = html.match(/<select id="discovery-source"[\s\S]*?<\/select>/i)?.[0];
  assert.ok(select, 'personal booking form discovery selector is missing');

  const options = [];
  for (const match of select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)) {
    const attrs = parseOptionAttributes(match[1]);
    if (!attrs.value) continue;
    options.push({
      key: attrs.value,
      label: match[2].trim(),
      detailMode: attrs['data-detail-mode'] || 'none',
      detailLabel: attrs['data-detail-label'] || '',
    });
  }
  return options;
}

assertRegistryShape();

const registryKeys = registry.sources.map((source) => source.key);
const database = await latestDatabaseDiscoveryKeys();
assert.deepEqual(
  sorted(database.keys),
  sorted(registryKeys),
  `database discovery_source constraint in ${database.file} drifted from config/discovery-sources.json`,
);

const ai = await latestAiDiscoveryKeys();
assert.deepEqual(
  sorted(ai.keys),
  sorted(registryKeys),
  `AI discovery_source validator in ${ai.file} drifted from config/discovery-sources.json`,
);

const personal = await personalFormSources();
assert.deepEqual(
  personal.map((source) => source.key),
  registryKeys,
  'personal booking form discovery-source order/keys drifted from the shared registry',
);

for (let index = 0; index < registry.sources.length; index += 1) {
  const source = registry.sources[index];
  const option = personal[index];
  assert.equal(option.label, source.labels.en, `personal form label drift for ${source.key}`);
  assert.equal(option.detailMode, source.detail.mode, `personal form detail mode drift for ${source.key}`);
  const expectedLabel = source.detail.label_en.replaceAll('{artist}', 'Vladimir');
  assert.equal(option.detailLabel, expectedLabel, `personal form detail label drift for ${source.key}`);
}

console.log(
  `Discovery-source registry contract is aligned across ${registryKeys.length} canonical categories, DB constraint, AI validator and personal booking form.`,
);
