#!/usr/bin/env node
//
// Repository secret scan.
//
// Looks for committed credential VALUES, not variable names: `SUPABASE_SERVICE_ROLE_KEY`
// appearing in documentation is correct and expected, while a JWT that starts
// `eyJhbGciOi` is not.
//
// This is a guard rail, not a guarantee. It catches the common shapes; it
// cannot catch a secret that looks like ordinary text.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.venv-gsc', '__pycache__',
  '.geo-agent-local', 'coverage',
]);

// Binary and vendored content is skipped: a font or a JPEG will trip a
// high-entropy pattern by chance, and neither can carry a credential we wrote.
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.pdf', '.zip', '.gz', '.mp4', '.webm', '.avif',
]);

const SKIP_PATH_PREFIXES = ['assets/vendor/', 'assets/portfolio/', 'assets/gallery/'];

const PATTERNS = [
  { name: 'JSON Web Token (Supabase anon/service key)', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Supabase access token', pattern: /\bsbp_[A-Za-z0-9]{20,}/ },
  { name: 'Supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'Telegram bot token', pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/ },
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'OAuth refresh token', pattern: /\b1\/\/0[A-Za-z0-9_-]{30,}/ },
  {
    name: 'Postgres connection string with a password',
    // A literal password, not a placeholder such as <PASSWORD> or [YOUR-PASSWORD].
    pattern: /postgres(?:ql)?:\/\/[^\s:@/]+:(?![<\[$])[^\s:@/]{8,}@/,
  },
  {
    name: 'Assigned secret-looking value',
    pattern: /(?:SERVICE_ROLE_KEY|BOT_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|API_TOKEN|DB_PASSWORD)\s*[:=]\s*["']?([A-Za-z0-9_$\-.]{16,})["']?/,
    // This one is a heuristic on the variable NAME, so it also fires on test
    // stubs, runbook placeholders and ordinary variable references. Those are
    // filtered out below; the exact-shape patterns above are never exempted.
    allowPlaceholders: true,
  },
];

// A value that announces itself as fabricated. Exempting these keeps the
// heuristic pattern usable without weakening the exact-shape patterns above,
// which are never exempted.
const PLACEHOLDER_MARKERS = [
  'test', 'example', 'placeholder', 'your-', 'your_', 'changeme',
  'dummy', 'fake', 'sample', 'redacted', 'xxxx', '<', '${',
];

/** `env.SUPABASE_SERVICE_ROLE_KEY` reads a secret; it does not contain one. */
const REFERENCE_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/;

function looksLikePlaceholder(value) {
  if (REFERENCE_EXPRESSION.test(value)) return true;
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

// This scanner necessarily contains the patterns it looks for.
const SELF = 'scripts/scan-secrets.mjs';

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...await listFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(path.join(dir, entry.name));
  }

  return files;
}

const findings = [];
let scanned = 0;

for (const file of await listFiles(rootDir)) {
  const rel = path.relative(rootDir, file).split(path.sep).join('/');
  if (rel === SELF) continue;
  if (SKIP_PATH_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;

  const size = (await stat(file)).size;
  if (size > 2 * 1024 * 1024) continue;

  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;

  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const { name, pattern, allowPlaceholders } of PATTERNS) {
      const match = pattern.exec(lines[index]);
      if (!match) continue;
      const value = match[1] ?? match[0];
      if (allowPlaceholders && looksLikePlaceholder(value)) continue;
      findings.push({ file: rel, line: index + 1, name });
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret scan FAILED: ${findings.length} potential credential value(s) found.`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.name}`);
  }
  process.exit(1);
}

console.log(`Secret scan passed: ${scanned} text files checked against ${PATTERNS.length} credential patterns; no committed credential value found.`);
