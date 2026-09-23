// WhatsApp outbound drain on the shared production scheduler (audit follow-up).
// The Cloudflare account has no spare cron trigger, so the drain Worker is
// invoked over a Service Binding from the existing */5 scheduler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWhatsappSummary,
  createProductionScheduler,
  runSharedWhatsappDrain,
} from '../workers/telegram-production-scheduler.js';

const quiet = () => {};
const log = console.log;
const error = console.error;
console.log = quiet;
console.error = quiet;

try {
  assert.deepEqual(assertWhatsappSummary({ ok: true, skipped: false, claimed: 2, succeeded: 1, failed: 1, unrecorded: 0 }),
    { skipped: false, claimed: 2, succeeded: 1, failed: 1, unrecorded: 0 });
  assert.throws(() => assertWhatsappSummary({ ok: true, claimed: 1, succeeded: 2, failed: 0, unrecorded: 0 }),
    (e) => e.code === 'whatsapp_shared_drain_summary_invalid', 'counts must add up');
  assert.throws(() => assertWhatsappSummary({ ok: false, errorCode: 'database_unavailable' }),
    (e) => e.code === 'database_unavailable', 'a remote failure keeps its safe code');
  assert.throws(() => assertWhatsappSummary({ ok: false, errorCode: 'Bad Code!' }),
    (e) => e.code === 'whatsapp_shared_drain_failed');

  const calls = [];
  const service = {
    async fetch(url, init) {
      calls.push({ url: String(url), method: init?.method });
      return Response.json({ ok: true, skipped: false, claimed: 1, succeeded: 1, failed: 0, unrecorded: 0 });
    },
  };
  const summary = await runSharedWhatsappDrain({ WHATSAPP_SERVICE: service });
  assert.equal(summary.succeeded, 1);
  assert.deepEqual(calls, [{ url: 'https://whatsapp.internal/internal/whatsapp/drain', method: 'POST' }]);

  await assert.rejects(runSharedWhatsappDrain({}), (e) => e.code === 'whatsapp_service_binding_unavailable');
  await assert.rejects(runSharedWhatsappDrain({ WHATSAPP_SERVICE: { fetch: async () => new Response('x', { status: 500 }) } }),
    (e) => e.code === 'whatsapp_service_unavailable');

  // Isolation: a WhatsApp failure never suppresses sibling scheduler tasks.
  const ran = [];
  const base = { scheduled(_c, _e, ctx) { ctx.waitUntil(Promise.resolve(ran.push('telegram'))); }, fetch() {} };
  const scheduler = createProductionScheduler(base);
  let settled;
  scheduler.scheduled({}, {
    VISHAR_ENVIRONMENT: 'production',
    WHATSAPP_SHARED_DRAIN_ENABLED: 'true',
    WHATSAPP_SERVICE: { fetch: async () => { throw new Error('down'); } },
  }, { waitUntil(p) { settled = p; } });
  await assert.rejects(settled);
  assert.deepEqual(ran, ['telegram'], 'the Telegram task still ran');

  // Disabled or non-production: never called.
  let touched = false;
  const guarded = createProductionScheduler({ scheduled() {}, fetch() {} });
  guarded.scheduled({}, { VISHAR_ENVIRONMENT: 'production', WHATSAPP_SHARED_DRAIN_ENABLED: 'false', WHATSAPP_SERVICE: { fetch: () => { touched = true; } } }, { waitUntil() {} });
  guarded.scheduled({}, { VISHAR_ENVIRONMENT: 'preview', WHATSAPP_SHARED_DRAIN_ENABLED: 'true', WHATSAPP_SERVICE: { fetch: () => { touched = true; } } }, { waitUntil() {} });
  assert.equal(touched, false);

  // The generated production scheduler config binds exactly this Worker.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-')), 'scheduler.toml');
  const gen = spawnSync(process.execPath, ['scripts/generate-telegram-production-deploy-config.mjs', out], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /WHATSAPP_SHARED_DRAIN_ENABLED = "true"/);
  assert.match(text, /\[\[services\]\]\nbinding = "WHATSAPP_SERVICE"\nservice = "vishar-whatsapp-drain-production"/);
  assert.equal((text.match(/^crons = /gm) || []).length, 1, 'still exactly one cron for the whole scheduler');
  const tracked = fs.readFileSync('wrangler.telegram-drain.production.toml', 'utf8');
  assert.match(tracked, /WHATSAPP_SHARED_DRAIN_ENABLED = "false"/, 'the tracked template stays inert');
} finally {
  console.log = log;
  console.error = error;
}
console.log('WhatsApp shared scheduler tests passed: Service Binding dispatch on the existing cron, validated counts, isolated failure, production-only.');
