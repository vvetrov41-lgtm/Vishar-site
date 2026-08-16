import assert from 'node:assert/strict';
import worker from '../workers/gpt-actions-production-full.js';

{
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/privacy'),
    {},
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /artist-scoped operational CRM/);
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

console.log('GPT full production wrapper tests passed: accurate privacy boundary and preserved rate limit.');
