import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'admin/dist');

const bannedText = [
  'calendar-staging.vishartattoo.com',
  'intake-staging.vishartattoo.com',
  'monzo-staging.vishartattoo.com',
  'gpt-actions-staging.vishartattoo.com',
  'vishar-crm-staging.pages.dev',
  'vishar-booking-staging.pages.dev',
  'tattooai-preview',
];

const requiredProductionConnectOrigins = [
  'https://team.vishartattoo.com',
  'https://calendar.vishartattoo.com',
  'https://monzo.vishartattoo.com',
  'https://instagram.vishartattoo.com',
];

// The retained staging Supabase project ref is deliberately NOT banned here.
// `admin/src/lib/whatsapp-connections-api.ts` carries both project origins as
// constants so it can classify which environment the CRM is pointed at and
// derive the correct artist integration key suffix. It is a discriminator, not
// an endpoint the production CRM talks to. Worker artifacts have no such
// discriminator, so their production scans do reject that ref.

const credentialPatterns = [
  {
    name: 'Supabase secret-key-shaped value',
    pattern: /sb_secret_[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: 'JWT-shaped value',
    pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  throw new Error(`CRM artifact directory does not exist: ${root}`);
}

const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
};
walk(root);

if (files.length === 0) {
  throw new Error(`CRM artifact directory is empty: ${root}`);
}

const findings = [];
for (const file of files) {
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;

  const content = buffer.toString('utf8');
  for (const marker of bannedText) {
    if (content.includes(marker)) {
      findings.push(`${path.relative(root, file)} contains banned staging marker ${marker}`);
    }
  }

  for (const { name, pattern } of credentialPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      findings.push(`${path.relative(root, file)} contains a ${name}`);
    }
  }
}

const headersPath = path.join(root, '_headers');
if (!fs.existsSync(headersPath)) {
  findings.push('_headers is missing from the private CRM artifact');
} else {
  const headers = fs.readFileSync(headersPath, 'utf8');
  const cspLine = headers.split(/\r?\n/).find((line) => line.trim().startsWith('Content-Security-Policy:')) ?? '';
  const connectSrc = /(?:^|;)\s*connect-src\s+([^;]+)/.exec(cspLine)?.[1] ?? '';
  for (const origin of requiredProductionConnectOrigins) {
    if (!connectSrc.split(/\s+/).includes(origin)) {
      findings.push(`_headers connect-src is missing reviewed production origin ${origin}`);
    }
  }
  if (connectSrc.includes('https://*.vishartattoo.com')) {
    findings.push('_headers connect-src must not wildcard Vishar connector hosts');
  }
}

if (findings.length > 0) {
  console.error('Private CRM artifact safety scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Private CRM artifact safety scan passed for ${files.length} files.`);
