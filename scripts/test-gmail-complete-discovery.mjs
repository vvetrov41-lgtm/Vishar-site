import assert from 'node:assert/strict';
import { __testing as discovery } from '../workers/gmail-complete-discovery-api.js';

let passes = 0;
async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

const mailbox = 'studio@example.test';
const knownEmail = 'known.client@example.test';
const knownClientId = '96310000-0000-4000-8000-000000000001';

function metadataMessage(id, from, to, timestamp, subject = 'Tattoo enquiry') {
  return {
    id,
    internalDate: String(new Date(timestamp).getTime()),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(timestamp).toUTCString() },
      ],
    },
  };
}

await test('30-day discovery paginates beyond 100 mailbox messages and excludes drafts', async () => {
  const firstPageIds = Array.from({ length: 100 }, (_, index) => `msg${String(index + 1).padStart(4, '0')}`);
  const secondPageId = 'msg0101';
  const listingQueries = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/gmail/v1/users/me/messages') {
      listingQueries.push(url.searchParams);
      if (!url.searchParams.get('pageToken')) {
        return Response.json({
          messages: firstPageIds.map((id) => ({ id })),
          nextPageToken: 'page_two',
        });
      }
      assert.equal(url.searchParams.get('pageToken'), 'page_two');
      return Response.json({ messages: [{ id: secondPageId }] });
    }

    const id = url.pathname.split('/').pop();
    if (firstPageIds.includes(id)) {
      const index = firstPageIds.indexOf(id);
      return Response.json(metadataMessage(
        id,
        `noise${index}@example.test`,
        mailbox,
        `2026-08-${String(20 + (index % 9)).padStart(2, '0')}T10:00:00.000Z`,
        `Noise ${index}`,
      ));
    }
    if (id === secondPageId) {
      return Response.json(metadataMessage(
        id,
        knownEmail,
        mailbox,
        '2026-08-20T09:00:00.000Z',
        'Known client after 100 newer messages',
      ));
    }
    throw new Error(`unexpected Gmail request: ${url.pathname}`);
  };

  const seen = await discovery.listCompleteRecentCorrespondents('synthetic-access-token', {
    mailboxEmail: mailbox,
    fetchImpl,
  });

  assert.equal(seen.length, 101);
  assert.equal(seen.some((row) => row.email === knownEmail), true);
  assert.equal(listingQueries.length, 2);
  for (const params of listingQueries) {
    const q = params.get('q');
    assert.match(q, /newer_than:30d/);
    assert.match(q, /-in:drafts/);
    assert.match(q, /-in:chats/);
    assert.match(q, /-in:spam/);
    assert.match(q, /-in:trash/);
    assert.equal(params.get('maxResults'), '500');
  }
  assert.equal(Object.keys(seen[0]).some((key) => key.includes('provider') || key === 'id' || key === 'threadId'), false);
});

await test('only database-matched clients reach the public discovery payload', () => {
  const seen = [
    { email: 'unknown@example.test', subject: 'Unknown', timestamp: '2026-08-31T12:00:00.000Z', direction: 'inbound' },
    { email: knownEmail, subject: 'Known', timestamp: '2026-08-31T11:00:00.000Z', direction: 'inbound' },
  ];
  const clients = discovery.buildPublicClients(seen, [{
    client_id: knownClientId,
    client_email: knownEmail,
    full_name: 'Known Client',
  }]);

  assert.deepEqual(clients, [{
    client_id: knownClientId,
    client_name: 'Known Client',
    subject: 'Known',
    last_message_at: '2026-08-31T11:00:00.000Z',
    direction: 'inbound',
    untrusted_content: true,
  }]);
  assert.equal(JSON.stringify(clients).includes('unknown@example.test'), false);
  assert.equal(JSON.stringify(clients).includes(knownEmail), false);
  assert.equal(JSON.stringify(clients).includes('provider'), false);
});

await test('database matching is chunked without truncating more than 200 observed addresses', async () => {
  const calls = [];
  const db = {
    async backendRpc(name, args) {
      assert.equal(name, 'service_match_gmail_clients');
      calls.push(args);
      return [];
    },
  };
  const seen = Array.from({ length: 401 }, (_, index) => ({ email: `client${index}@example.test` }));
  await discovery.matchKnownClients(db, 'a1111111-1111-4111-8111-111111111111', seen);
  assert.deepEqual(calls.map((call) => call.p_emails.length), [200, 200, 1]);
  assert.equal(calls.every((call) => call.p_artist_id === 'a1111111-1111-4111-8111-111111111111'), true);
});

await test('draft-like metadata cannot bypass the Gmail query boundary', () => {
  const item = discovery.correspondentFromMetadata(
    metadataMessage('msgdraft', knownEmail, mailbox, '2026-08-31T10:00:00.000Z'),
    mailbox,
  );
  assert.equal(item.email, knownEmail);
  // The parser intentionally has no label authority. Draft exclusion therefore
  // belongs in the Gmail list query and is asserted in the pagination test.
});

console.log(`gmail complete discovery: ${passes} tests passed`);
