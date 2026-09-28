import assert from 'node:assert/strict';
import { bindingNameFor } from '../workers/lib/provider-routing.js';
import {
  maintainWhatsappBookingTemplates,
  __testing,
} from '../workers/lib/whatsapp-booking-templates.js';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const ROUTE = 'vladimir-production';
const WABA = '123456789012345';
const TOKEN = 'synthetic-template-access-token-1234567890';
const BINDING = bindingNameFor('whatsapp', ROUTE);

function target(overrides = {}) {
  return {
    artist_id: ARTIST,
    integration_key: ROUTE,
    tattoo_template_name: 'booking_card_tattoo_v1',
    consultation_template_name: 'booking_card_consultation_v1',
    template_language: 'en_GB',
    tattoo_template_status: null,
    consultation_template_status: null,
    ...overrides,
  };
}

function env() {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
    [BINDING]: JSON.stringify({
      phoneNumberId: '100000000000001',
      wabaId: WABA,
      accessToken: TOKEN,
    }),
  };
}

{
  const tattoo = __testing.templateDefinition(
    'tattoo',
    'booking_card_tattoo_v1',
    'en_GB',
  );
  assert.equal(tattoo.category, 'UTILITY');
  assert.deepEqual(tattoo.components[0], { type: 'HEADER', format: 'LOCATION' });
  assert.equal(tattoo.components[1].type, 'BODY');
  assert.match(tattoo.components[1].text, /Deposit paid: \{\{5\}\}/);
  assert.match(tattoo.components[1].text, /Remaining balance: \{\{6\}\}/);
  assert.deepEqual(tattoo.components[2].buttons, [
    { type: 'QUICK_REPLY', text: "I'll be there" },
    { type: 'QUICK_REPLY', text: 'Need another time' },
  ]);

  const consultation = __testing.templateDefinition(
    'consultation',
    'booking_card_consultation_v1',
    'en_GB',
  );
  assert.equal(consultation.components[1].text.includes('Deposit'), false);
  assert.equal(consultation.components[1].text.includes('balance'), false);
}

{
  const rpcCalls = [];
  const graphCalls = [];
  let templates = [];

  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'service_claim_booking_card_template_targets') {
        return Response.json([target()]);
      }
      if (name === 'service_record_booking_card_template_status') {
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected RPC ${name}`);
    }

    if (value.startsWith(`https://graph.facebook.com/v25.0/${WABA}/message_templates`)) {
      const method = String(init.method || 'GET').toUpperCase();
      graphCalls.push({ value, method, body: init.body ? JSON.parse(init.body) : null });
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.redirect, 'manual');
      if (method === 'GET') return Response.json({ data: structuredClone(templates) });
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        templates.push({
          id: String(9000 + templates.length),
          name: body.name,
          language: body.language,
          category: body.category,
          status: 'PENDING',
        });
        return Response.json({ id: templates.at(-1).id, status: 'PENDING' });
      }
    }
    throw new Error(`unexpected request ${value}`);
  };

  const result = await maintainWhatsappBookingTemplates(env(), { fetchImpl });
  assert.deepEqual(result, {
    targets: 1,
    checked: 1,
    created: 2,
    approved: 0,
    failed: 0,
  });

  const posts = graphCalls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.category, 'UTILITY');
  assert.equal(posts[0].body.components[0].format, 'LOCATION');
  assert.equal(posts[1].body.components[1].text.includes('Deposit'), false);

  const record = rpcCalls.find((call) => call.name === 'service_record_booking_card_template_status');
  assert.deepEqual(record.args, {
    p_artist_id: ARTIST,
    p_tattoo_status: 'PENDING',
    p_consultation_status: 'PENDING',
    p_error_code: null,
  });
}

{
  const rpcCalls = [];
  const graphCalls = [];
  const templates = [
    { id: '1', name: 'booking_card_tattoo_v1', language: 'en_GB', category: 'UTILITY', status: 'APPROVED' },
    { id: '2', name: 'booking_card_consultation_v1', language: 'en_GB', category: 'UTILITY', status: 'APPROVED' },
  ];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'service_claim_booking_card_template_targets') return Response.json([target()]);
      if (name === 'service_record_booking_card_template_status') return Response.json({ ok: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith(`https://graph.facebook.com/v25.0/${WABA}/message_templates`)) {
      graphCalls.push({ method: String(init.method || 'GET').toUpperCase() });
      return Response.json({ data: templates });
    }
    throw new Error(`unexpected request ${value}`);
  };

  const result = await maintainWhatsappBookingTemplates(env(), { fetchImpl });
  assert.deepEqual(result, {
    targets: 1,
    checked: 1,
    created: 0,
    approved: 1,
    failed: 0,
  });
  assert.equal(graphCalls.some((call) => call.method === 'POST'), false);
}

{
  const rpcCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (!value.includes('/rest/v1/rpc/')) throw new Error('provider must not be reached');
    const name = value.split('/').pop();
    const args = JSON.parse(init.body || '{}');
    rpcCalls.push({ name, args });
    if (name === 'service_claim_booking_card_template_targets') {
      return Response.json([target({ integration_key: 'missing-production' })]);
    }
    if (name === 'service_record_booking_card_template_status') return Response.json({ ok: true });
    throw new Error(`unexpected RPC ${name}`);
  };

  const result = await maintainWhatsappBookingTemplates(env(), { fetchImpl });
  assert.equal(result.failed, 1);
  const record = rpcCalls.find((call) => call.name === 'service_record_booking_card_template_status');
  assert.equal(record.args.p_error_code, 'provider_binding_missing');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
}

{
  const rpcCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      rpcCalls.push({ name, args: JSON.parse(init.body || '{}') });
      if (name === 'service_claim_booking_card_template_targets') return Response.json([target()]);
      if (name === 'service_record_booking_card_template_status') return Response.json({ ok: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith(`https://graph.facebook.com/v25.0/${WABA}/message_templates`)) {
      if (String(init.method || 'GET').toUpperCase() === 'GET') return Response.json({ data: [] });
      return Response.json({
        error: {
          message: 'Echoed Hi {{1}}, your tattoo session is booked',
          error_user_msg: 'Echoed user text',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2388024,
          fbtrace_id: 'TRACE123',
        },
      }, { status: 400 });
    }
    throw new Error(`unexpected request ${value}`);
  };

  const result = await maintainWhatsappBookingTemplates(env(), { fetchImpl });
  assert.equal(result.failed, 1);
  const record = rpcCalls.find((call) => call.name === 'service_record_booking_card_template_status');
  assert.equal(record.args.p_error_code, 'whatsapp_template_rejected');
  assert.deepEqual(record.args.p_provider_error, {
    stage: 'create_tattoo',
    http_status: 400,
    code: 100,
    subcode: 2388024,
    type: 'OAuthException',
  });
  const serialised = JSON.stringify(rpcCalls);
  assert.equal(serialised.includes('Echoed'), false);
  assert.equal(serialised.includes('TRACE123'), false);
  assert.equal(serialised.includes(TOKEN), false);
}

{
  const rpcCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      rpcCalls.push({ name, args: JSON.parse(init.body || '{}') });
      if (name === 'service_claim_booking_card_template_targets') return Response.json([target()]);
      if (name === 'service_record_booking_card_template_status') return Response.json({ ok: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    return new Response('<html>not json</html>', { status: 400 });
  };

  await maintainWhatsappBookingTemplates(env(), { fetchImpl });
  const record = rpcCalls.find((call) => call.name === 'service_record_booking_card_template_status');
  assert.deepEqual(record.args.p_provider_error, {
    stage: 'list',
    http_status: 400,
    code: null,
    subcode: null,
    type: null,
  });
}

{
  const { readProviderError } = __testing;
  let pulled = 0;
  const huge = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 100) throw new Error('reader was not stopped at the cap');
      controller.enqueue(new Uint8Array(4096).fill(0x61));
    },
  });
  const diagnostic = await readProviderError(new Response(huge, { status: 400 }));
  assert.deepEqual(diagnostic, { http_status: 400, code: null, subcode: null, type: null });
  assert.ok(pulled <= 4, `read ${pulled} chunks past the cap`);

  const declared = await readProviderError(new Response('{"error":{"code":1}}', {
    status: 400,
    headers: { 'content-length': '999999' },
  }));
  assert.equal(declared.code, null);
}

console.log('WhatsApp booking template maintenance tests passed.');
