import assert from 'node:assert/strict';
import worker, { __testing } from '../workers/gpt-actions-production-full.js';

{
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/privacy'),
    {},
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /artist-scoped operational CRM/);
  assert.match(html, /server-owned active Artist context/);
  assert.match(html, /legacy artist-bound GPT clients remain fixed/i);
  assert.match(html, /canonical contact information/);
  assert.match(html, /Finance and communications are separate owner-controlled capabilities/);
  assert.match(html, /Storage paths, checksums, signed URLs and file bytes are not exposed/);
  assert.match(html, /arbitrary SQL/);
  assert.match(html, /team-role administration/);
  assert.doesNotMatch(html, /retained-staging|service_role|SUPABASE_SECRET_KEY|sb_secret_/);
}

{
  const seen = [];
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/privacy', {
      headers: { 'CF-Connecting-IP': '203.0.113.70' },
    }),
    {
      GPT_RATE_LIMIT: {
        async limit({ key }) {
          seen.push(key);
          return { success: false };
        },
      },
    },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.deepEqual(seen, ['privacy:203.0.113.70']);
}

for (const host of ['gpt-communications.vishartattoo.com', 'gpt-operations.vishartattoo.com']) {
  const request = new Request(`https://${host}/v1/enquiries/00000000-0000-4000-8000-000000000001/gmail/history`);
  assert.equal(
    __testing.isGmailActionRoute(request),
    true,
    `${host} must route Gmail through the provider service during Builder migration`,
  );

  const seen = [];
  const response = await worker.fetch(request, {
    GMAIL_SERVICE: {
      async fetch(forwarded) {
        seen.push(new URL(forwarded.url).hostname);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen, [host]);
}

assert.equal(
  __testing.isGmailActionRoute(
    new Request('https://gpt-actions.vishartattoo.com/v1/enquiries/00000000-0000-4000-8000-000000000001/gmail/history'),
  ),
  false,
  'Core host must not proxy Gmail actions',
);

console.log('GPT full production wrapper tests passed: profile-bound privacy, rate limit and Communications Gmail routing with legacy Operations compatibility.');
