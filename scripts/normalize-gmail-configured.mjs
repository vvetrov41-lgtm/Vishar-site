import fs from 'node:fs';

const file = 'workers/gmail-production.js';
const source = fs.readFileSync(file, 'utf8');
const before = `function configured(env) {\n  return env?.VISHAR_ENVIRONMENT === 'production'\n    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN`;
const after = `function configured(env) {\n  return Boolean(env?.VISHAR_ENVIRONMENT === 'production'\n    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN`;
const tailBefore = `    && env?.GMAIL_OAUTH_STATE\n    && env?.GMAIL_OAUTH_TOKENS;\n}`;
const tailAfter = `    && env?.GMAIL_OAUTH_STATE\n    && env?.GMAIL_OAUTH_TOKENS);\n}`;
if (!source.includes(before) || !source.includes(tailBefore)) throw new Error('configured predicate shape changed');
const next = source.replace(before, after).replace(tailBefore, tailAfter);
if (next === source) throw new Error('configured predicate was not normalized');
fs.writeFileSync(file, next);
