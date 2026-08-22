// Guarded Telegram webhook activation.
//
// This is deliberately NOT a GitHub Actions workflow.
//
// Registering a webhook is one HTTPS call. Turning it into a workflow would
// mean storing the shared bot token and the webhook secret as GitHub secrets,
// purely to automate that one call. GitHub already holds a Cloudflare API
// token because deploying is impossible without it; a Telegram bot token is
// avoidable, and every avoidable copy of a production credential is one more
// place it can leak from. So the credentials stay where they are already
// needed - encrypted Cloudflare Worker secrets - and this runs from an
// operator's own shell with the values in its environment.
//
// It never prints either credential, refuses any URL but the exact production
// callback, and requires --confirm before it changes anything.
//
//   TELEGRAM_BOT_TOKEN=... node scripts/activate-telegram-webhook.mjs verify
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
//     node scripts/activate-telegram-webhook.mjs register --confirm
//   TELEGRAM_BOT_TOKEN=... node scripts/activate-telegram-webhook.mjs delete --confirm

const EXPECTED_WEBHOOK_URL = 'https://telegram.vishartattoo.com/webhook';
const ACTIONS = new Set(['verify', 'register', 'delete']);

export function parseArgs(argv) {
  const [action = 'verify', ...rest] = argv;
  if (!ACTIONS.has(action)) {
    throw new Error(`unknown action: ${action}`);
  }
  const unknown = rest.filter((flag) => flag !== '--confirm');
  if (unknown.length) throw new Error(`unknown flag: ${unknown[0]}`);
  return { action, confirm: rest.includes('--confirm') };
}

export function requireCredentials(env, action) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === 'string' ? env.TELEGRAM_BOT_TOKEN.trim() : '';
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing or does not look like a bot token');
  }
  if (action !== 'register') return { token, secret: null };

  const secret = typeof env.TELEGRAM_WEBHOOK_SECRET === 'string'
    ? env.TELEGRAM_WEBHOOK_SECRET.trim()
    : '';
  // Telegram's own constraint for secret_token.
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -');
  }
  return { token, secret };
}

// getWebhookInfo returns the configured URL and pending counts. Nothing here is
// a credential, but the shape is pinned so a surprise field is not printed.
export function safeWebhookSummary(info) {
  return {
    url: typeof info?.url === 'string' ? info.url : '',
    matches_expected: info?.url === EXPECTED_WEBHOOK_URL,
    has_custom_certificate: Boolean(info?.has_custom_certificate),
    pending_update_count: Number(info?.pending_update_count ?? 0),
    last_error_date: info?.last_error_date ?? null,
    last_error_message: typeof info?.last_error_message === 'string'
      ? info.last_error_message.slice(0, 200)
      : null,
  };
}

async function callTelegram(token, method, body, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    redirect: 'error',
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!response.ok || !parsed?.ok) {
    // Telegram echoes the request URL in some errors; never surface it.
    const description = typeof parsed?.description === 'string'
      ? parsed.description.replace(new RegExp(token, 'g'), '<redacted>').slice(0, 200)
      : 'unknown error';
    throw new Error(`Telegram ${method} failed: ${description}`);
  }
  return parsed.result;
}

export async function run(argv, env, fetchImpl = fetch, log = console.log) {
  const { action, confirm } = parseArgs(argv);
  const { token, secret } = requireCredentials(env, action);

  if (action !== 'verify' && !confirm) {
    throw new Error(`${action} changes production Telegram routing; pass --confirm`);
  }

  if (action === 'register') {
    await callTelegram(token, 'setWebhook', {
      url: EXPECTED_WEBHOOK_URL,
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }, fetchImpl);
  } else if (action === 'delete') {
    await callTelegram(token, 'deleteWebhook', { drop_pending_updates: true }, fetchImpl);
  }

  const info = await callTelegram(token, 'getWebhookInfo', {}, fetchImpl);
  const summary = safeWebhookSummary(info);
  log(JSON.stringify(summary, null, 2));

  if (action === 'register' && !summary.matches_expected) {
    throw new Error('webhook did not settle on the expected production URL');
  }
  return summary;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  run(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : 'activation failed');
    process.exit(1);
  });
}
