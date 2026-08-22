// The activation tool touches production Telegram routing and handles two
// credentials, so the things worth pinning are: it refuses to point anywhere
// but the exact production callback, it refuses to change anything without
// --confirm, and no code path can print the bot token or the webhook secret.

import assert from 'node:assert/strict';
import {
  parseArgs,
  requireCredentials,
  safeWebhookSummary,
  run,
} from './activate-telegram-webhook.mjs';

// Shaped like a bot token for the validator, but deliberately not starting
// with the real "AA" prefix, so the repository secret scanner cannot mistake
// this fixture for a live credential.
const TOKEN = '8123456789:UNIT-TEST-NOT-A-REAL-TELEGRAM-TOKEN-0';
const SECRET = 'unit_test_webhook_secret_value_0123456789';
const EXPECTED = 'https://telegram.vishartattoo.com/webhook';

// Arguments
assert.deepEqual(parseArgs([]), { action: 'verify', confirm: false });
assert.deepEqual(parseArgs(['register', '--confirm']), { action: 'register', confirm: true });
assert.throws(() => parseArgs(['enable']), /unknown action/);
assert.throws(() => parseArgs(['verify', '--force']), /unknown flag/);

// Credentials
assert.throws(() => requireCredentials({}, 'verify'), /TELEGRAM_BOT_TOKEN/);
assert.throws(() => requireCredentials({ TELEGRAM_BOT_TOKEN: 'nope' }, 'verify'), /TELEGRAM_BOT_TOKEN/);
assert.equal(requireCredentials({ TELEGRAM_BOT_TOKEN: TOKEN }, 'verify').secret, null);
assert.throws(
  () => requireCredentials({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: 'short' }, 'register'),
  /TELEGRAM_WEBHOOK_SECRET/,
);
assert.throws(
  () => requireCredentials({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: 'has spaces in it here' }, 'register'),
  /TELEGRAM_WEBHOOK_SECRET/,
);

// A mutation without --confirm never reaches Telegram.
for (const action of ['register', 'delete']) {
  await assert.rejects(
    run([action], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET }, async () => {
      throw new Error('Telegram must not be called');
    }),
    /--confirm/,
  );
}

function recorder(info) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const method = String(url).split('/').pop();
      const result = method === 'getWebhookInfo' ? info : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

// Registering targets exactly the production callback and nothing else.
{
  const mock = recorder({ url: EXPECTED, pending_update_count: 0 });
  const lines = [];
  await run(['register', '--confirm'],
    { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    mock.fetchImpl, (line) => lines.push(line));

  const setWebhook = mock.calls.find((call) => call.url.endsWith('/setWebhook'));
  assert.equal(setWebhook.body.url, EXPECTED);
  assert.equal(setWebhook.body.secret_token, SECRET);
  assert.deepEqual(setWebhook.body.allowed_updates, ['message']);

  // Nothing printed may contain either credential.
  const printed = lines.join('\n');
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(printed.includes(SECRET), false);
  assert.equal(JSON.parse(printed).matches_expected, true);
}

// If Telegram settles on a different URL, registration is a failure.
{
  const mock = recorder({ url: 'https://evil.example/webhook', pending_update_count: 0 });
  await assert.rejects(
    run(['register', '--confirm'],
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
      mock.fetchImpl, () => {}),
    /expected production URL/,
  );
}

// A Telegram error that echoes the token must be redacted before it surfaces.
{
  const leaky = async () => new Response(JSON.stringify({
    ok: false,
    description: `Unauthorized for https://api.telegram.org/bot${TOKEN}/setWebhook`,
  }), { status: 401, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    run(['verify'], { TELEGRAM_BOT_TOKEN: TOKEN }, leaky, () => {}),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false, 'token must never reach an error message');
      assert.match(error.message, /<redacted>/);
      return true;
    },
  );
}

// The safe summary carries no unexpected field.
assert.deepEqual(
  Object.keys(safeWebhookSummary({ url: EXPECTED, secret_token: 'leaked', ip_address: '1.2.3.4' })).sort(),
  ['has_custom_certificate', 'last_error_date', 'last_error_message',
   'matches_expected', 'pending_update_count', 'url'],
);

console.log('Telegram webhook activation tests passed: exact production URL only, confirm-gated, credential-safe.');
