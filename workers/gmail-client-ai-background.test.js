import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureKnownGmailReplies, matchCaptureCandidates, __testing,
  MAX_CAPTURE_CANDIDATES, MAX_CAPTURE_PER_RUN,
} from './gmail-client-ai-background.js';

const ENV = { VISHAR_ENVIRONMENT: 'production', GMAIL_READ_ENABLED: 'true' };
const ARTIST = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MAILBOX = 'studio@example.com';
const EMAIL = 'client@example.com';
const AT = '2026-11-13T01:00:00.000Z';
const metadata = [{
  email: EMAIL, direction: 'inbound',
  timestamp: AT, provider_message_id: 'gmailmsg001',
  provider_thread_id: 'gmailthread01', subject: 'Tattoo plan',
}];
const matched = [{ client_id: CLIENT, client_email: EMAIL }];

function message({ id = 'gmailmsg001', threadId = 'gmailthread01', from = EMAIL,
  to = MAILBOX, cc = null, bcc = null, body = 'December works, but please use black and grey.',
  date = AT } = {}) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: 'Tattoo plan' },
    ...(cc ? [{ name: 'Cc', value: cc }] : []),
    ...(bcc ? [{ name: 'Bcc', value: bcc }] : []),
  ];
  return {
    id, threadId, internalDate: String(Date.parse(date)),
    labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers,
      body: { data: Buffer.from(body, 'utf8').toString('base64url') } },
  };
}

test('capture keeps private ids scoped to known inbound client mail and refuses ambiguous email match', () => {
  assert.equal(MAX_CAPTURE_PER_RUN, 2);
  assert.equal(MAX_CAPTURE_CANDIDATES, 20);
  assert.deepEqual(matchCaptureCandidates(metadata, matched), [{
    provider_message_id: 'gmailmsg001', provider_thread_id: 'gmailthread01',
    client_id: CLIENT, client_email: EMAIL, occurred_at: AT,
  }]);
  assert.equal(matchCaptureCandidates(metadata, [matched[0], {
    client_id: '33333333-3333-4333-8333-333333333333', client_email: EMAIL,
  }]).length, 0, 'never guess which CRM client an email belongs to');
  assert.equal(matchCaptureCandidates([{ ...metadata[0], direction: 'outbound' }], matched).length, 0);
  assert.equal(matchCaptureCandidates([{ ...metadata[0], email: 'unknown@example.com' }], matched).length, 0);
  assert.equal(matchCaptureCandidates([...metadata, ...metadata], matched).length, 1);
});

test('captures only latest authored reply, never quoted previous content', () => {
  assert.equal(__testing.freshReply(
    'Sounds good.\n\nOn Friday, 12 November at 10:15 Alice wrote:\n> Please confirm the rate.'
  ), 'Sounds good.');
  assert.equal(__testing.freshReply('Actual new message\n-----Original Message-----\nQuoted'), 'Actual new message');
  assert.equal(__testing.freshReply('hi').length, 2);
  assert.equal(__testing.freshReply('x'.repeat(6000)).length, 3500);
});

test('backend selection gate runs before any Gmail full-body request; disabled DB gate does not fetch', async () => {
  const calls = [];
  const result = await captureKnownGmailReplies({
    env: ENV, artistId: ARTIST, mailboxEmail: MAILBOX, metadata, matched,
    accessToken: 'test-token', fetchImpl: async () => { throw Error('no network'); },
    rpc: async (_env, action, args) => {
      calls.push({ action, args });
      return []; // DB gate disabled / historical provider timestamp
    },
    gmailGet: async () => { throw Error('full content must never be requested'); },
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.considered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'service_select_background_gmail_ai_candidates');
  assert.equal(calls[0].args.p_artist_id, ARTIST);
  assert.equal(calls[0].args.p_mailbox_email, MAILBOX);
});

test('stores bounded strict bilateral content once and never sends or queues legacy enquiry AI', async () => {
  const actions = [];
  const urls = [];
  const result = await captureKnownGmailReplies({
    env: ENV, artistId: ARTIST, mailboxEmail: MAILBOX, metadata, matched,
    accessToken: 'test-token', fetchImpl: async () => {},
    rpc: async (_env, action, args) => {
      actions.push({ action, args });
      return action === 'service_select_background_gmail_ai_candidates'
        ? matchCaptureCandidates(metadata, matched)
        : { status: 'recorded' };
    },
    gmailGet: async (url) => {
      urls.push(url);
      return message({ body: 'Yes, 8 December is good.\nOn Friday, 12 November wrote:\n> Older request' });
    },
  });
  assert.equal(result.recorded, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(urls, ['/gmail/v1/users/me/messages/gmailmsg001?format=full']);
  assert.deepEqual(actions.map(x => x.action), [
    'service_select_background_gmail_ai_candidates',
    'service_record_background_gmail_ai_message',
  ]);
  assert.equal(actions[1].args.p_body, 'Yes, 8 December is good.');
  assert.equal(actions[1].args.p_client_id, CLIENT);
  assert.equal(actions[1].args.p_occurred_at, AT);
  assert.ok(!actions.some(x => /enquiry_ai|send|draft/.test(x.action)));
});

test('rejects CC groups, wrong thread/message, unknown sender and changed timestamp', async () => {
  for (const bad of [
    message({ cc: 'third@example.com' }),
    message({ bcc: 'third@example.com' }),
    message({ from: 'third@example.com' }),
    message({ to: 'team@example.com' }),
    message({ id: 'differentmessage' }),
    message({ threadId: 'differentthread' }),
    message({ date: '2026-11-13T01:01:00.000Z' }),
  ]) {
    let writes = 0;
    const result = await captureKnownGmailReplies({
      env: ENV, artistId: ARTIST, mailboxEmail: MAILBOX, metadata, matched,
      accessToken: 'token',
      rpc: async (_env, action) => {
        if (action === 'service_select_background_gmail_ai_candidates') {
          return matchCaptureCandidates(metadata, matched);
        }
        writes += 1;
        return { status: 'recorded' };
      },
      gmailGet: async () => bad,
    });
    assert.equal(writes, 0);
    assert.equal(result.skipped, 1);
  }
});

test('candidate selector cannot forge a different client, ID or timestamp', async () => {
  for (const override of [{ client_id: '99999999-9999-4999-8999-999999999999' },
    { provider_message_id: 'forgedmsg' },
    { occurred_at: '2026-11-13T02:00:00.000Z' }]) {
    let fullReads = 0;
    const result = await captureKnownGmailReplies({
      env: ENV, artistId: ARTIST, mailboxEmail: MAILBOX, metadata, matched,
      accessToken: 'token',
      rpc: async () => [{ ...matchCaptureCandidates(metadata, matched)[0], ...override }],
      gmailGet: async () => { fullReads += 1; return message(); },
    });
    assert.equal(result.failed, 1);
    assert.equal(fullReads, 0);
  }
});

test('no real mailbox, client, message or legacy extractor is contacted when disabled', async () => {
  for (const env of [{ ...ENV, VISHAR_ENVIRONMENT: 'preview' }, {
    ...ENV, GMAIL_READ_ENABLED: 'false',
  }]) {
    const result = await captureKnownGmailReplies({
      env, artistId: ARTIST, mailboxEmail: MAILBOX, metadata, matched,
      accessToken: 'test', rpc: async () => { throw Error('unexpected DB'); },
      gmailGet: async () => { throw Error('unexpected Gmail'); },
    });
    assert.equal(result.considered, 0);
  }
});
