// Cloudflare Worker helper for sending website tattoo leads to Telegram.
// Do not put secrets in this file.
// Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Cloudflare Worker secrets/variables.

export async function handleTelegramLead(request, env) {
  const data = await request.json().catch(() => ({}));

  if (data.type !== 'lead' && data.type !== 'sendIdea') {
    return null;
  }

  const name = clean(data.name) || 'Not provided';
  const contact = clean(data.contact);
  const preferredReply = clean(data.preferredReply) || 'No preference';
  const originalIdea = clean(data.originalIdea || data.message) || 'Not provided';
  const aiSummary = clean(data.aiSummary || data.summary) || 'Not provided';
  const page = clean(data.page) || 'Website';

  if (!contact) {
    return jsonResponse({ ok: false, error: 'Contact is required.' }, 400);
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return jsonResponse({ ok: false, error: 'Telegram is not configured.' }, 500);
  }

  const text = [
    '🖤 New tattoo idea from website',
    '',
    `Name: ${name}`,
    `Contact: ${contact}`,
    `Preferred reply: ${preferredReply}`,
    `Page: ${page}`,
    '',
    'Original idea:',
    originalIdea,
    '',
    'AI summary:',
    aiSummary
  ].join('\n');

  const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });

  if (!telegramResponse.ok) {
    const details = await telegramResponse.text().catch(() => 'Telegram request failed.');
    return jsonResponse({ ok: false, error: details }, 502);
  }

  return jsonResponse({ ok: true });
}

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 3500);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://vishartattoo.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
