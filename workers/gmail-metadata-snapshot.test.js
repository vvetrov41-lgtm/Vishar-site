import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from './gmail-metadata-snapshot.js';

test('Gmail metadata refresh stays bounded and times provider calls out', () => {
  assert.equal(__testing.METADATA_CONCURRENCY, 5);
  assert.equal(__testing.PROVIDER_TIMEOUT_MS, 5000);
  assert.equal(__testing.SNAPSHOT_WINDOW_DAYS, 30);
});

test('snapshot keeps only matched known clients and the newest metadata', () => {
  const refreshedAt = '2026-09-18T00:00:00.000Z';
  const rows = __testing.latestKnownRows(
    '11111111-1111-4111-8111-111111111111',
    [
      { email: 'known@example.com', subject: 'older', timestamp: '2026-09-17T10:00:00.000Z', direction: 'inbound' },
      { email: 'unknown@example.com', subject: 'unknown', timestamp: '2026-09-17T11:00:00.000Z', direction: 'inbound' },
      { email: 'known@example.com', subject: 'newer', timestamp: '2026-09-17T12:00:00.000Z', direction: 'outbound' },
    ],
    [{
      client_id: '22222222-2222-4222-8222-222222222222',
      client_email: 'known@example.com',
      full_name: 'Known Client',
    }],
    refreshedAt,
  );
  assert.deepEqual(rows, [{
    artist_id: '11111111-1111-4111-8111-111111111111',
    client_id: '22222222-2222-4222-8222-222222222222',
    subject: 'newer',
    last_message_at: '2026-09-17T12:00:00.000Z',
    direction: 'outbound',
    refreshed_at: refreshedAt,
  }]);
});

test('metadata parser never returns provider ids or bodies', () => {
  const row = __testing.metadataCorrespondent({
    id: 'provider-secret-id',
    internalDate: String(Date.parse('2026-09-17T12:00:00.000Z')),
    payload: {
      body: { data: 'secret-body' },
      headers: [
        { name: 'From', value: 'Client <client@example.com>' },
        { name: 'To', value: 'Artist <artist@example.com>' },
        { name: 'Subject', value: 'Hello' },
      ],
    },
  }, 'artist@example.com');
  assert.deepEqual(row, {
    email: 'client@example.com',
    subject: 'Hello',
    timestamp: '2026-09-17T12:00:00.000Z',
    direction: 'inbound',
  });
  assert.equal('id' in row, false);
  assert.equal('body' in row, false);
});

const ENV = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_only_value',
};
const ARTIST = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('mailboxes are listed through the backend RPC, never the integrations table', async () => {
  const calls = [];
  const rows = await __testing.listEnabledMailboxes(ENV, async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return jsonResponse([
      { artist_id: ARTIST, integration_key: 'google_gmail_vladimir', external_account_label: 'studio@example.com' },
      { artist_id: 'not-a-uuid', integration_key: 'x', external_account_label: 'x@example.com' },
    ]);
  });
  assert.deepEqual(calls, [{
    url: 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/service_list_gmail_mailboxes',
    method: 'POST',
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artist_id, ARTIST);
});

test('history evidence is direction and time only, strictly between mailbox and client', () => {
  const at = Date.parse('2026-07-01T09:30:00.000Z');
  const message = (from, to) => ({
    id: 'provider-id',
    internalDate: String(at),
    payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: 'secret' }] },
  });
  assert.deepEqual(
    __testing.historyEvidence(message('Client <client@example.com>', 'studio@example.com'), 'studio@example.com', 'client@example.com'),
    { direction: 'inbound', last_message_at: '2026-07-01T09:30:00.000Z' },
  );
  assert.deepEqual(
    __testing.historyEvidence(message('studio@example.com', 'Client <CLIENT@example.com>'), 'studio@example.com', 'client@example.com'),
    { direction: 'outbound', last_message_at: '2026-07-01T09:30:00.000Z' },
  );
  assert.equal(
    __testing.historyEvidence(message('someone@example.com', 'studio@example.com'), 'studio@example.com', 'client@example.com'),
    null,
    'a message from someone else is not this client\'s conversation',
  );
});

test('history backfill records the newest message, or a checked miss, and sends nothing', async () => {
  const recorded = [];
  const gmailPaths = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/rpc/service_list_gmail_history_candidates')) {
      return jsonResponse([
        { client_id: CLIENT, client_email: 'client@example.com' },
        { client_id: '33333333-3333-4333-8333-333333333333', client_email: 'quiet@example.com' },
      ]);
    }
    if (href.includes('/rpc/service_record_gmail_client_history')) {
      recorded.push(JSON.parse(init.body));
      return jsonResponse(null);
    }
    if (href.startsWith('https://gmail.googleapis.com/')) {
      assert.equal(init.method, 'GET', 'the provider is only ever read');
      gmailPaths.push(href);
      if (href.includes('/messages?')) {
        const query = new URL(href).searchParams.get('q');
        return jsonResponse(query.includes('client@example.com') ? { messages: [{ id: 'msg12345' }] } : {});
      }
      return jsonResponse({
        internalDate: String(Date.parse('2026-06-15T08:00:00.000Z')),
        payload: { headers: [{ name: 'From', value: 'client@example.com' }, { name: 'To', value: 'studio@example.com' }] },
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  const checked = await __testing.backfillClientHistory(ENV, ARTIST, 'token-value', 'studio@example.com', fetchImpl);
  assert.equal(checked, 2);
  assert.deepEqual(recorded, [
    { p_artist_id: ARTIST, p_client_id: CLIENT, p_last_message_at: '2026-06-15T08:00:00.000Z', p_direction: 'inbound' },
    { p_artist_id: ARTIST, p_client_id: '33333333-3333-4333-8333-333333333333', p_last_message_at: null, p_direction: null },
  ]);
  assert.ok(gmailPaths.every((href) => !href.includes('/send')));
  assert.equal(
    new URL(gmailPaths[0]).searchParams.get('q'),
    '{from:"client@example.com" to:"client@example.com"} -in:drafts -in:chats -in:spam -in:trash',
  );
});

test('a run stays inside the Worker subrequest limit even in the worst case', () => {
  const worstCase = 1 // mailbox list RPC
    + 1 // Google token refresh
    + 1 // profile
    + 1 // message list
    + __testing.METADATA_MESSAGES_PER_RUN
    + 1 // match known clients
    + 2 // snapshot upsert and prune
    + 1 // history candidates
    + __testing.HISTORY_CLIENTS_PER_RUN * (1 + __testing.HISTORY_MESSAGES_PER_CLIENT + 1);
  assert.ok(worstCase <= __testing.SUBREQUEST_BUDGET, `worst case ${worstCase}`);
  assert.ok(__testing.SUBREQUEST_BUDGET < 50, 'below the free-plan cap of 50 subrequests');
});

test('a reply run stays inside the same subrequest limit', () => {
  const worstCase = 1 + 1 + 1 + 1 + __testing.METADATA_MESSAGES_PER_RUN + 1 + 2
    + 1 // outbound evidence
    + 1 // reply candidates
    + __testing.REPLY_ENQUIRIES_PER_RUN * (1 + 1 + 1) // list, oldest message, record
    + __testing.REPLY_EXTRA_CALLS_PER_RUN; // extra pages or message reads, shared by the run
  assert.ok(worstCase <= __testing.SUBREQUEST_BUDGET, `worst case ${worstCase}`);
});

test('only SENT outbound messages to known clients become reply evidence, once each', () => {
  const sentMessage = (labelIds) => ({
    internalDate: String(Date.parse('2026-09-23T19:36:35.000Z')),
    labelIds,
    payload: { headers: [{ name: 'From', value: 'studio@example.com' }, { name: 'To', value: 'Client <client@example.com>' }] },
  });
  const sent = __testing.metadataCorrespondent(sentMessage(['SENT']), 'studio@example.com');
  const scheduled = __testing.metadataCorrespondent(sentMessage(['SCHEDULED']), 'studio@example.com');
  assert.equal(sent.sent, true);
  assert.equal('sent' in scheduled, false, 'a scheduled or draft message is not a reply');
  const rows = __testing.outboundEvidenceRows(
    [sent, { ...sent }, scheduled,
      { email: 'stranger@example.com', direction: 'outbound', sent: true, timestamp: '2026-09-23T20:00:00.000Z' },
      { email: 'client@example.com', direction: 'inbound', timestamp: '2026-09-23T19:52:41.000Z' }],
    [{ client_id: CLIENT, client_email: 'client@example.com' }],
  );
  assert.deepEqual(rows, [{ client_id: CLIENT, sent_at: '2026-09-23T19:36:35.000Z' }]);
});

test('reply lookup records the oldest SENT mail after the enquiry, a checked miss, and sends nothing', async () => {
  const recorded = [];
  const gmailPaths = [];
  const ENQUIRY = '44444444-4444-4444-8444-444444444444';
  const QUIET = '55555555-5555-4555-8555-555555555555';
  const DRAFTY = '66666666-6666-4666-8666-666666666666';
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/rpc/service_list_gmail_reply_candidates')) {
      assert.deepEqual(JSON.parse(init.body), { p_artist_id: ARTIST, p_limit: __testing.REPLY_ENQUIRIES_PER_RUN });
      return jsonResponse([
        { enquiry_id: ENQUIRY, client_email: 'client@example.com', created_at: '2026-09-23T14:10:23.732Z', closed_at: '2026-09-30T08:00:00.000Z' },
        { enquiry_id: QUIET, client_email: 'quiet@example.com', created_at: '2026-09-23T14:10:23.732Z' },
        { enquiry_id: DRAFTY, client_email: 'drafty@example.com', created_at: '2026-09-23T14:10:23.732Z' },
      ]);
    }
    if (href.includes('/rpc/service_record_gmail_enquiry_reply_check')) {
      recorded.push(JSON.parse(init.body));
      return jsonResponse(null);
    }
    if (href.startsWith('https://gmail.googleapis.com/')) {
      assert.equal(init.method, 'GET', 'the provider is only ever read');
      gmailPaths.push(href);
      if (href.includes('/messages?')) {
        const query = new URL(href).searchParams.get('q');
        if (query.includes('quiet@example.com')) return jsonResponse({});
        // Newest first: the last id is the first reply.
        return jsonResponse({ messages: [{ id: 'newest123' }, { id: 'oldest123' }] });
      }
      const drafty = gmailPaths.some((path) => path.includes('drafty'));
      const oldest = /oldest123/.test(href);
      return jsonResponse({
        internalDate: String(Date.parse(oldest ? '2026-09-23T19:36:35.000Z' : '2026-09-24T10:00:00.000Z')),
        labelIds: drafty && oldest ? ['DRAFT'] : ['SENT'],
        payload: { headers: [{ name: 'From', value: 'studio@example.com' },
          { name: 'To', value: drafty ? 'drafty@example.com' : 'client@example.com' }] },
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  const checked = await __testing.backfillEnquiryReplies(ENV, ARTIST, 'token-value', 'studio@example.com', fetchImpl);
  assert.equal(checked, 3);
  assert.deepEqual(recorded, [
    { p_artist_id: ARTIST, p_enquiry_id: ENQUIRY, p_first_sent_at: '2026-09-23T19:36:35.000Z', p_complete: true },
    { p_artist_id: ARTIST, p_enquiry_id: QUIET, p_first_sent_at: null, p_complete: true },
    // The oldest message is not SENT; the next one is read from the shared pool.
    { p_artist_id: ARTIST, p_enquiry_id: DRAFTY, p_first_sent_at: '2026-09-24T10:00:00.000Z', p_complete: true },
  ]);
  assert.ok(gmailPaths.every((href) => !href.includes('/send')));
  assert.equal(
    new URL(gmailPaths[0]).searchParams.get('q'),
    `from:"studio@example.com" to:"client@example.com" after:${Math.floor(Date.parse('2026-09-23T14:10:23.732Z') / 1000)}`
      + ` before:${Math.floor(Date.parse('2026-09-30T08:00:00.000Z') / 1000)}`
      + ' -in:drafts -in:scheduled -in:chats -in:spam -in:trash',
  );
  assert.equal(new URL(gmailPaths[2]).searchParams.get('q').includes('before:'), false,
    'an enquiry with no later enquiry has an open window');
});

test('a reply after the client\'s next enquiry is never returned for the earlier one', async () => {
  const sentAt = await __testing.firstSentAfter('token-value', 'studio@example.com', 'client@example.com',
    '2026-09-23T14:10:23.732Z', async (url) => {
      const href = String(url);
      if (href.includes('/messages?')) return jsonResponse({ messages: [{ id: 'later1234' }] });
      return jsonResponse({
        internalDate: String(Date.parse('2026-09-30T09:00:00.000Z')),
        labelIds: ['SENT'],
        payload: { headers: [{ name: 'From', value: 'studio@example.com' }, { name: 'To', value: 'client@example.com' }] },
      });
    }, '2026-09-30T08:00:00.000Z');
  assert.deepEqual(sentAt, { sentAt: null, complete: true });
});

test('a reply before the enquiry is never returned as its first reply', async () => {
  const sentAt = await __testing.firstSentAfter('token-value', 'studio@example.com', 'client@example.com',
    '2026-09-23T14:10:23.732Z', async (url) => {
      const href = String(url);
      if (href.includes('/messages?')) return jsonResponse({ messages: [{ id: 'older1234' }] });
      return jsonResponse({
        internalDate: String(Date.parse('2026-09-23T14:10:23.000Z')),
        labelIds: ['SENT'],
        payload: { headers: [{ name: 'From', value: 'studio@example.com' }, { name: 'To', value: 'client@example.com' }] },
      });
    });
  assert.deepEqual(sentAt, { sentAt: null, complete: true });
});

function pagedGmail(pages, times) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/messages?')) {
      const token = new URL(href).searchParams.get('pageToken') || '0';
      const index = Number(token);
      return jsonResponse({
        messages: pages[index].map((id) => ({ id })),
        ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}),
      });
    }
    const id = /messages\/([A-Za-z0-9_-]+)\?/.exec(href)[1];
    return jsonResponse({
      internalDate: String(Date.parse(times[id])),
      labelIds: ['SENT'],
      payload: { headers: [{ name: 'From', value: 'studio@example.com' }, { name: 'To', value: 'client@example.com' }] },
    });
  };
  return { calls, fetchImpl };
}

test('more than one page of sent mail: the earliest is on the last page and is returned', async () => {
  const { calls, fetchImpl } = pagedGmail(
    [['newest01', 'newer002'], ['older003', 'oldest04']],
    { oldest04: '2026-09-23T15:00:00.000Z' },
  );
  const pool = { extra: __testing.REPLY_EXTRA_CALLS_PER_RUN };
  const result = await __testing.firstSentAfter('token-value', 'studio@example.com', 'client@example.com',
    '2026-09-23T14:10:23.732Z', fetchImpl, null, pool);
  assert.deepEqual(result, { sentAt: '2026-09-23T15:00:00.000Z', complete: true });
  assert.equal(calls.filter((href) => href.includes('/messages?')).length, 2, 'the second page was read');
  assert.equal(new URL(calls[0]).searchParams.get('maxResults'), String(__testing.REPLY_LOOKUP_MAX_RESULTS));
  assert.equal(pool.extra, __testing.REPLY_EXTRA_CALLS_PER_RUN - 1, 'the extra page came from the shared pool');
});

test('a window larger than the run can page through is answered without a first-reply time', async () => {
  const { fetchImpl } = pagedGmail(
    [['page0001'], ['page0002'], ['page0003'], ['page0004']],
    { page0001: '2026-09-29T10:00:00.000Z', page0002: '2026-09-28T10:00:00.000Z', page0003: '2026-09-27T10:00:00.000Z' },
  );
  const result = await __testing.firstSentAfter('token-value', 'studio@example.com', 'client@example.com',
    '2026-09-23T14:10:23.732Z', fetchImpl, null, { extra: 2 });
  assert.equal(result.complete, false, 'an unread older page means this is not the first reply');
  assert.equal(result.sentAt, '2026-09-27T10:00:00.000Z', 'but a SENT reply in the window is proven');
});

test('evidence recording is one bounded backend call and skipped when empty', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return jsonResponse(1); };
  assert.equal(await __testing.recordOutboundEvidence(ENV, ARTIST, [], fetchImpl), 0);
  assert.equal(calls.length, 0);
  await __testing.recordOutboundEvidence(ENV, ARTIST, [{ client_id: CLIENT, sent_at: '2026-09-23T19:36:35.000Z' }], fetchImpl);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/service_record_gmail_outbound_messages$/);
  assert.deepEqual(calls[0].body, {
    p_artist_id: ARTIST,
    p_messages: [{ client_id: CLIENT, sent_at: '2026-09-23T19:36:35.000Z' }],
  });
});

test('the budgeted fetch refuses calls beyond its limit', async () => {
  let calls = 0;
  const budgeted = __testing.budgetedFetch(async () => { calls += 1; return jsonResponse({}); }, 2);
  await budgeted('https://example.com/1');
  await budgeted('https://example.com/2');
  await assert.rejects(budgeted('https://example.com/3'), /gmail_subrequest_budget_exhausted/);
  assert.equal(calls, 2);
});

test('the snapshot reads one bounded page of the newest messages', async () => {
  const paths = [];
  const rows = await __testing.listRecentMetadata('token-value', 'studio@example.com', async (url) => {
    const href = String(url);
    paths.push(href);
    if (href.includes('/messages?')) {
      return jsonResponse({
        messages: Array.from({ length: 500 }, (_, index) => ({ id: `message${String(index).padStart(4, '0')}` })),
        nextPageToken: 'more-pages-exist',
      });
    }
    return jsonResponse({
      internalDate: String(Date.parse('2026-09-20T10:00:00.000Z')),
      payload: { headers: [{ name: 'From', value: 'client@example.com' }, { name: 'To', value: 'studio@example.com' }] },
    });
  });
  const listCalls = paths.filter((href) => href.includes('/messages?'));
  assert.equal(listCalls.length, 1, 'no pagination');
  assert.equal(new URL(listCalls[0]).searchParams.get('maxResults'), String(__testing.METADATA_MESSAGES_PER_RUN));
  assert.equal(paths.length, 1 + __testing.METADATA_MESSAGES_PER_RUN);
  assert.equal(rows.length, __testing.METADATA_MESSAGES_PER_RUN);
});

test('the snapshot only forgets clients whose last message left the 30-day window', async () => {
  const calls = [];
  await __testing.persistSnapshot(ENV, ARTIST, [{ artist_id: ARTIST, client_id: CLIENT }], '2026-09-28T00:00:00.000Z',
    async (url, init) => { calls.push({ url: new URL(String(url)), method: init.method }); return jsonResponse(null); });
  const prune = calls.find((call) => call.method === 'DELETE');
  assert.equal(prune.url.searchParams.get('last_message_at'), 'lt.2026-08-29T00:00:00.000Z');
  assert.equal(prune.url.searchParams.get('refreshed_at'), null);
});

test('a failed mailbox list is one failed run, never a thrown Service Binding call', async () => {
  const { refreshGmailMetadataSnapshots } = await import('./gmail-metadata-snapshot.js');
  const env = { ...ENV, VISHAR_ENVIRONMENT: 'production', GMAIL_READ_ENABLED: 'true' };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const summary = await refreshGmailMetadataSnapshots(env, async () => jsonResponse({ message: 'upstream' }, 503));
    // Valid for the shared scheduler: refreshed + failed <= artists.
    assert.deepEqual(summary, { skipped: false, artists: 1, refreshed: 0, failed: 1 });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /"stage":"list_mailboxes"/);
    assert.doesNotMatch(logged[0], /sb_secret|supabase\.co/);
  } finally {
    console.error = originalError;
  }
});
