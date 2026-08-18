import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootEnv = {
  ...process.env,
  GMAIL_KV_STATE_ID: '1'.repeat(32),
  GMAIL_KV_TOKENS_ID: '2'.repeat(32),
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_syntheticproductionvalue000000000000',
};

function render(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-phase-'));
  const output = join(dir, 'wrangler.toml');
  try {
    const result = spawnSync(process.execPath, ['scripts/generate-gmail-production-deploy-config.mjs', output, phase], {
      cwd: process.cwd(),
      env: rootEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${phase} generator failed: ${result.stderr}`);
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectFlag(config, name, value) {
  assert.match(config, new RegExp(`${name} = "${value}"`));
}

const bootstrap = render('bootstrap');
expectFlag(bootstrap, 'GMAIL_OAUTH_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_READ_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_VLADIMIR_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_KRISTINA_ENABLED', 'false');
assert.equal(bootstrap.includes('[triggers]'), false);

const vladimirRead = render('vladimir-read');
expectFlag(vladimirRead, 'GMAIL_OAUTH_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_READ_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(vladimirRead, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_KRISTINA_ENABLED', 'false');
assert.equal(vladimirRead.includes('[triggers]'), false);

const vladimirSend = render('vladimir-send');
expectFlag(vladimirSend, 'GMAIL_DRAIN_ENABLED', 'true');
expectFlag(vladimirSend, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(vladimirSend, 'GMAIL_KRISTINA_ENABLED', 'false');
assert.match(vladimirSend, /\[triggers\][\s\S]*crons = \["\*\/5 \* \* \* \*"\]/);

const kristinaRead = render('kristina-read');
expectFlag(kristinaRead, 'GMAIL_OAUTH_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_READ_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(kristinaRead, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_KRISTINA_ENABLED', 'true');
assert.equal(kristinaRead.includes('[triggers]'), false);

const kristinaSend = render('kristina-send');
expectFlag(kristinaSend, 'GMAIL_DRAIN_ENABLED', 'true');
expectFlag(kristinaSend, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(kristinaSend, 'GMAIL_KRISTINA_ENABLED', 'true');
assert.match(kristinaSend, /\[triggers\][\s\S]*crons = \["\*\/5 \* \* \* \*"\]/);

console.log('Gmail rollout phase tests passed: 5');
