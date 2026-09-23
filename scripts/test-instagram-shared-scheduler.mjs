// Instagram maintenance on the shared production scheduler.
//
// Webhook delivery must be enabled per connected Instagram account and idle
// tokens must be renewed. The Instagram Worker has no cron trigger (the account
// has none spare), so the existing */5 scheduler calls it over a Service
// Binding, like the WhatsApp drain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertInstagramMaintenanceSummary,
  createProductionScheduler,
  runSharedInstagramMaintenance,
} from '../workers/telegram-production-scheduler.js';

const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};

try {
  assert.deepEqual(
    assertInstagramMaintenanceSummary({ ok: true, targets: 2, checked: 2, subscribed: 1, failed: 1 }),
    { targets: 2, checked: 2, subscribed: 1, failed: 1 },
  );
  assert.throws(() => assertInstagramMaintenanceSummary({ ok: true, targets: 1, checked: 2, subscribed: 2, failed: 0 }),
    (e) => e.code === 'instagram_maintenance_summary_invalid', 'cannot check more accounts than exist');
  assert.throws(() => assertInstagramMaintenanceSummary({ ok: true, targets: 2, checked: 2, subscribed: 2, failed: 1 }),
    (e) => e.code === 'instagram_maintenance_summary_invalid', 'counts must add up');
  assert.throws(() => assertInstagramMaintenanceSummary({ ok: false, errorCode: 'instagram_rpc_unavailable' }),
    (e) => e.code === 'instagram_rpc_unavailable', 'a remote failure keeps its safe code');
  assert.throws(() => assertInstagramMaintenanceSummary({ ok: false, errorCode: 'Bad Code!' }),
    (e) => e.code === 'instagram_maintenance_failed');

  const calls = [];
  const service = {
    async fetch(url, init) {
      calls.push({ url: String(url), method: init?.method });
      return Response.json({ ok: true, targets: 2, checked: 0, subscribed: 0, failed: 0 });
    },
  };
  const summary = await runSharedInstagramMaintenance({ INSTAGRAM_SERVICE: service });
  assert.equal(summary.targets, 2);
  assert.deepEqual(calls, [{ url: 'https://instagram.internal/internal/instagram/maintain', method: 'POST' }]);

  await assert.rejects(runSharedInstagramMaintenance({}), (e) => e.code === 'instagram_service_binding_unavailable');
  await assert.rejects(
    runSharedInstagramMaintenance({ INSTAGRAM_SERVICE: { fetch: async () => new Response('x', { status: 404 }) } }),
    (e) => e.code === 'instagram_service_unavailable',
    'an Instagram Worker without the route yet is a reported failure, not a crash',
  );

  // Isolation: an Instagram failure never suppresses sibling scheduler tasks.
  const ran = [];
  const base = { scheduled(_c, _e, ctx) { ctx.waitUntil(Promise.resolve(ran.push('telegram'))); }, fetch() {} };
  let settled;
  createProductionScheduler(base).scheduled({}, {
    VISHAR_ENVIRONMENT: 'production',
    INSTAGRAM_SHARED_MAINTENANCE_ENABLED: 'true',
    INSTAGRAM_SERVICE: { fetch: async () => { throw new Error('down'); } },
  }, { waitUntil(p) { settled = p; } });
  await assert.rejects(settled);
  assert.deepEqual(ran, ['telegram'], 'the Telegram task still ran');

  // Disabled or non-production: never called.
  let touched = false;
  const guarded = createProductionScheduler({ scheduled() {}, fetch() {} });
  const probe = { fetch: () => { touched = true; } };
  guarded.scheduled({}, { VISHAR_ENVIRONMENT: 'production', INSTAGRAM_SHARED_MAINTENANCE_ENABLED: 'false', INSTAGRAM_SERVICE: probe }, { waitUntil() {} });
  guarded.scheduled({}, { VISHAR_ENVIRONMENT: 'preview', INSTAGRAM_SHARED_MAINTENANCE_ENABLED: 'true', INSTAGRAM_SERVICE: probe }, { waitUntil() {} });
  assert.equal(touched, false);

  // The generated production scheduler config binds exactly the Instagram Worker.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-sched-')), 'scheduler.toml');
  const gen = spawnSync(process.execPath, ['scripts/generate-telegram-production-deploy-config.mjs', out], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /INSTAGRAM_SHARED_MAINTENANCE_ENABLED = "true"/);
  assert.match(text, /\[\[services\]\]\nbinding = "INSTAGRAM_SERVICE"\nservice = "vishar-instagram-production"/);
  assert.equal((text.match(/^crons = /gm) || []).length, 1, 'still exactly one cron for the whole scheduler');
  const tracked = fs.readFileSync('wrangler.telegram-drain.production.toml', 'utf8');
  assert.match(tracked, /INSTAGRAM_SHARED_MAINTENANCE_ENABLED = "false"/, 'the tracked template stays inert');
  const instagramTemplate = fs.readFileSync('wrangler.instagram.production.toml', 'utf8');
  assert.ok(!/^\s*crons\s*=/m.test(instagramTemplate), 'the Instagram Worker still declares no cron of its own');
} finally {
  console.log = log;
  console.error = error;
}
console.log('Instagram shared scheduler tests passed: Service Binding maintenance on the existing cron, validated counts, isolated failure, production-only.');
