// Builds the Unified GPT v2 OpenAPI projections, one schema per semantic
// Action domain, from two sources:
//   - operations already imported today are copied verbatim from the legacy
//     production schemas (docs/gpt-actions/openapi.production.*.yaml);
//   - new operations are rendered from workers/lib/gpt-domain-operations.js,
//     the same registry the Worker routes with.
// Which domain an operation belongs to comes from the operator-parity
// inventory. Run with --check to fail when committed files are stale.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_PARITY, OWNER_EXTENSIONS, PARITY_METADATA } from '../docs/gpt-actions/operator-parity.current.mjs';
import { DOMAIN_OPERATIONS } from '../workers/lib/gpt-domain-operations.js';

const root = new URL('..', import.meta.url).pathname;
const outDir = join(root, 'docs/gpt-actions/unified');
const LEGACY = ['core', 'operations', 'communications', 'cloudflare'];

const OAUTH_SCOPE_TEXT = 'Authenticate the CRM user. CRM membership, server-owned active Artist context, GPT client capability ceiling and operation capabilities remain authoritative.';

export function slugFor(domain) {
  return domain.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------ legacy extraction
function parseLegacy(text, source) {
  const lines = text.split('\n');
  const operations = new Map();
  const schemas = new Map();
  let section = null;
  let currentPath = null;
  let currentMethod = null;
  let block = [];
  let schemaName = null;
  let schemaBlock = [];

  const flushOperation = () => {
    if (!currentMethod) return;
    const body = block.join('\n');
    const match = /^\s+operationId: ([A-Za-z0-9]+)$/m.exec(body);
    if (!match) throw new Error(`${source}: ${currentMethod} ${currentPath} has no operationId`);
    operations.set(match[1], { path: currentPath, method: currentMethod, lines: [...block], source });
    currentMethod = null;
    block = [];
  };
  const flushSchema = () => {
    if (schemaName) schemas.set(schemaName, schemaBlock.join('\n').replace(/\s+$/, ''));
    schemaName = null;
    schemaBlock = [];
  };

  for (const line of lines) {
    if (/^\S/.test(line)) {
      flushOperation();
      flushSchema();
      section = line.startsWith('paths:') ? 'paths' : line.startsWith('components:') ? 'components' : 'other';
      continue;
    }
    if (section === 'paths') {
      const pathMatch = /^  (\/\S+):\s*$/.exec(line);
      if (pathMatch) { flushOperation(); currentPath = pathMatch[1]; continue; }
      const methodMatch = /^    (get|post|put|patch|delete):\s*$/.exec(line);
      if (methodMatch) { flushOperation(); currentMethod = methodMatch[1]; block = [line]; continue; }
      if (currentMethod) block.push(line);
    } else if (section === 'components') {
      if (/^  \S/.test(line)) { flushSchema(); section = line.trim() === 'schemas:' ? 'schemas' : 'components'; continue; }
    }
    if (section === 'schemas') {
      if (/^  \S/.test(line)) { flushSchema(); section = 'components'; continue; }
      const nameMatch = /^    ([A-Za-z0-9_]+):\s*$/.exec(line);
      if (nameMatch) { flushSchema(); schemaName = nameMatch[1]; schemaBlock = [line]; continue; }
      if (schemaName) schemaBlock.push(line);
    }
  }
  flushOperation();
  flushSchema();
  // Trailing blank lines belong to no operation.
  for (const entry of operations.values()) {
    while (entry.lines.length && entry.lines.at(-1).trim() === '') entry.lines.pop();
  }
  return { operations, schemas };
}

export function loadLegacy() {
  const operations = new Map();
  const schemas = new Map();
  for (const name of LEGACY) {
    const parsed = parseLegacy(readFileSync(join(root, `docs/gpt-actions/openapi.production.${name}.yaml`), 'utf8'), name);
    for (const [id, entry] of parsed.operations) {
      if (operations.has(id)) throw new Error(`duplicate legacy operationId ${id}`);
      operations.set(id, entry);
    }
    for (const [schemaName, schemaText] of parsed.schemas) {
      if (schemas.has(schemaName) && schemas.get(schemaName) !== schemaText) {
        throw new Error(`legacy component schema ${schemaName} differs between files`);
      }
      schemas.set(schemaName, schemaText);
    }
  }
  return { operations, schemas };
}

// ------------------------------------------------------- registry rendering
const q = (value) => JSON.stringify(value);

function schemaFor(param) {
  const schema = {};
  switch (param.type) {
    case 'uuid': Object.assign(schema, { type: 'string', format: 'uuid' }); break;
    case 'string': Object.assign(schema, { type: 'string', maxLength: param.max }); if (param.pattern) schema.pattern = param.pattern; break;
    case 'clock': Object.assign(schema, { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }); break;
    case 'date': Object.assign(schema, { type: 'string', format: 'date' }); break;
    case 'date-time': Object.assign(schema, { type: 'string', format: 'date-time' }); break;
    case 'integer': Object.assign(schema, { type: 'integer' }); break;
    case 'number': Object.assign(schema, { type: 'number' }); break;
    case 'boolean': Object.assign(schema, { type: 'boolean' }); break;
    case 'enum': Object.assign(schema, { type: 'string', enum: [...param.values] }); break;
    case 'clock-array': Object.assign(schema, { type: 'array', maxItems: param.maxItems, items: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } }); break;
    case 'uuid-array': Object.assign(schema, { type: 'array', minItems: 1, maxItems: param.maxItems, items: { type: 'string', format: 'uuid' } }); break;
    default: throw new Error(`unknown parameter type ${param.type}`);
  }
  if (['integer', 'number'].includes(param.type)) {
    if (param.min != null) schema.minimum = param.min;
    if (param.max != null) schema.maximum = param.max;
  }
  if (param.default !== undefined) schema.default = param.default;
  if (param.description) schema.description = param.description;
  return schema;
}

function flow(value) {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, child]) => `${key}: ${flow(child)}`).join(', ')}}`;
  }
  return typeof value === 'string' ? q(value) : String(value);
}

function renderRegistryOperation(entry) {
  const lines = [`    ${entry.method.toLowerCase()}:`];
  lines.push(`      operationId: ${entry.id}`);
  lines.push(`      summary: ${q(entry.summary)}`);
  lines.push(`      x-openai-isConsequential: ${entry.consequential}`);
  if (entry.description) lines.push(`      description: ${q(entry.description)}`);
  const parameters = entry.params.filter((param) => param.in !== 'body');
  if (parameters.length) {
    lines.push('      parameters:');
    for (const param of parameters) {
      lines.push(`        - ${flow({ name: param.name, in: param.in, required: Boolean(param.required), schema: schemaFor(param) })}`);
    }
  }
  const bodyParams = entry.params.filter((param) => param.in === 'body');
  if (entry.method !== 'GET') {
    const required = bodyParams.filter((param) => param.required).map((param) => param.name);
    lines.push('      requestBody:');
    lines.push(`        required: ${required.length > 0}`);
    lines.push('        content:');
    lines.push('          application/json:');
    lines.push('            schema:');
    lines.push('              type: object');
    lines.push('              additionalProperties: false');
    if (required.length) lines.push(`              required: ${flow(required)}`);
    if (bodyParams.length) {
      lines.push('              properties:');
      for (const param of bodyParams) lines.push(`                ${param.name}: ${flow(schemaFor(param))}`);
    } else {
      lines.push('              properties: {}');
    }
  }
  lines.push(`      responses: {'200': {description: ${q(entry.consequential ? 'Result of the CRM action' : 'CRM data')}}, '400': {description: 'Invalid request'}, '403': {description: 'Not permitted for this CRM user, GPT client or active artist'}}`);
  return lines;
}

// ------------------------------------------------------------ projection
export function buildProjections() {
  const legacy = loadLegacy();
  const registry = new Map(DOMAIN_OPERATIONS.map((entry) => [entry.id, entry]));
  const projections = [];

  for (const [domain, host] of Object.entries(PARITY_METADATA.actionDomains)) {
    const ids = [
      ...OPERATOR_PARITY.filter((row) => row.actionDomain === domain && row.gpt.status !== 'ui_only').map((row) => row.gpt.operationId),
      ...OWNER_EXTENSIONS.filter((entry) => entry.actionDomain === domain).map((entry) => entry.operationId),
    ];
    const byPath = new Map();
    const included = [];
    const referenced = new Set();
    for (const id of ids) {
      let rendered;
      let path;
      if (registry.has(id)) {
        const entry = registry.get(id);
        if (entry.domain !== domain) throw new Error(`${id} is ${entry.domain} in the registry but ${domain} in parity`);
        rendered = renderRegistryOperation(entry);
        path = entry.path;
      } else if (legacy.operations.has(id)) {
        const entry = legacy.operations.get(id);
        rendered = entry.lines;
        path = entry.path;
        for (const match of entry.lines.join('\n').matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) referenced.add(match[1]);
      } else {
        continue; // implement_now and not implemented yet
      }
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(rendered);
      included.push(id);
    }

    // Transitively include component schemas referenced by included schemas.
    const pending = [...referenced];
    while (pending.length) {
      const name = pending.pop();
      const text = legacy.schemas.get(name);
      if (!text) throw new Error(`${domain}: missing component schema ${name}`);
      for (const match of text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) {
        if (!referenced.has(match[1])) { referenced.add(match[1]); pending.push(match[1]); }
      }
    }

    const slug = slugFor(domain);
    const out = [
      '# Generated by scripts/build-gpt-unified-openapi.mjs. Do not edit by hand.',
      'openapi: 3.1.0',
      'info:',
      `  title: ${q(`Vishar CRM ${domain} Actions`)}`,
      `  version: 3.0.0-unified-${slug}`,
      '  description: >-',
      `    ${domain} operations of the one profile-bound Vishar Unified GPT. The signed-in`,
      '    CRM user, the server-owned active artist context (read and changed only through',
      '    /v1/context), the GPT client ceiling and CRM capabilities are checked by the',
      '    database on every call. No action accepts an artist, workspace, OAuth client or',
      '    integration identifier.',
      'servers:',
      `  - url: https://${host}`,
      `    description: ${q(`Vishar CRM ${domain} action edge.`)}`,
      'security:',
      '  - supabaseOAuth: [email]',
      'paths:',
    ];
    for (const [path, operations] of byPath) {
      out.push(`  ${path}:`);
      for (const lines of operations) out.push(...lines);
    }
    out.push(
      'components:',
      '  securitySchemes:',
      '    supabaseOAuth:',
      '      type: oauth2',
      '      flows:',
      '        authorizationCode:',
      '          authorizationUrl: https://gpt-actions.vishartattoo.com/oauth/authorize',
      '          tokenUrl: https://gpt-actions.vishartattoo.com/oauth/token',
      '          scopes:',
      `            email: ${OAUTH_SCOPE_TEXT}`,
    );
    if (referenced.size) {
      out.push('  schemas:');
      for (const name of [...referenced].sort()) out.push(legacy.schemas.get(name));
    }
    projections.push({ domain, host, slug, operationIds: included, text: `${out.join('\n')}\n` });
  }
  return projections;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const projections = buildProjections();
  const stale = [];
  if (!check) mkdirSync(outDir, { recursive: true });
  for (const projection of projections) {
    // A domain with no implemented operation yet has nothing to import.
    if (projection.operationIds.length === 0) continue;
    const file = join(outDir, `openapi.${projection.slug}.yaml`);
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== projection.text) stale.push(file);
    } else {
      writeFileSync(file, projection.text);
    }
  }
  if (stale.length) {
    console.error(`Stale unified GPT schemas; run node scripts/build-gpt-unified-openapi.mjs:\n${stale.join('\n')}`);
    process.exit(1);
  }
  const total = projections.reduce((sum, projection) => sum + projection.operationIds.length, 0);
  console.log(`${check ? 'Checked' : 'Wrote'} ${projections.length} unified GPT schemas with ${total} operations.`);
  for (const projection of projections) console.log(`  ${projection.slug}: ${projection.operationIds.length}`);
}
