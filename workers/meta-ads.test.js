import test from 'node:test';
import assert from 'node:assert/strict';

import {
  META_ADS_CONFIG,
  __testing,
  readMetaAdsMeasurementContext,
} from './lib/meta-ads.js';

function form(values = {}) {
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
    },
  };
}

test('Meta measurement is disabled without explicit consent', () => {
  const context = readMetaAdsMeasurementContext(form({
    metaAdsSourceUrl: 'https://vishartattoo.com/booking/',
    metaAdsFbp: 'fb.1.1789400000000.1234567890',
  }), 'https://vishartattoo.com');
  assert.equal(context, null);
});

test('Meta measurement accepts consented first-party attribution only', () => {
  const context = readMetaAdsMeasurementContext(form({
    metaAdsMeasurementConsent: 'granted',
    metaAdsSourceUrl: 'https://vishartattoo.com/booking/?utm_source=meta#form',
    metaAdsFbp: 'fb.1.1789400000000.1234567890',
    metaAdsFbc: 'fb.1.1789400000000.ABC123',
  }), 'https://vishartattoo.com');

  assert.deepEqual(context, {
    sourceUrl: 'https://vishartattoo.com/booking/',
    fbp: 'fb.1.1789400000000.1234567890',
    fbc: 'fb.1.1789400000000.ABC123',
  });
});

test('Meta measurement rejects source-origin substitution', () => {
  const context = readMetaAdsMeasurementContext(form({
    metaAdsMeasurementConsent: 'granted',
    metaAdsSourceUrl: 'https://evil.example/booking/',
    metaAdsFbp: 'fb.1.1789400000000.1234567890',
  }), 'https://vishartattoo.com');
  assert.equal(context, null);
});

test('Meta cookie identifiers are validated but not hashed client-side', () => {
  assert.equal(
    __testing.sanitizeCookieValue('fb.1.1789400000000.1234567890'),
    'fb.1.1789400000000.1234567890',
  );
  assert.equal(__testing.sanitizeCookieValue('not a meta cookie'), '');
});

test('email normalization is deterministic and privacy-preserving hash is SHA-256', async () => {
  assert.equal(__testing.normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.equal(
    await __testing.sha256Hex('user@example.com'),
    'b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514',
  );
});

test('UK phone normalization produces Meta-compatible country digits', () => {
  assert.equal(__testing.normalizePhone('07123 456 789'), '447123456789');
  assert.equal(__testing.normalizePhone('+44 7123 456 789'), '447123456789');
  assert.equal(__testing.normalizePhone('0044 7123 456 789'), '447123456789');
});

test('artist integration key resolves only its own backend secret binding', () => {
  assert.equal(
    __testing.secretBindingName('meta_ads_vladimir', 'ACCESS_TOKEN'),
    'META_ADS_VLADIMIR_ACCESS_TOKEN',
  );
  assert.equal(
    __testing.secretBindingName('meta_ads_kristina', 'ACCESS_TOKEN'),
    'META_ADS_KRISTINA_ACCESS_TOKEN',
  );
  assert.throws(() => __testing.secretBindingName('meta_ads_vladimir/../kristina', 'ACCESS_TOKEN'));
});

test('production never reads a Meta test event code', () => {
  const env = {
    VISHAR_ENVIRONMENT: 'production',
    META_ADS_VLADIMIR_TEST_EVENT_CODE: 'TEST123',
  };
  assert.equal(__testing.readTestEventCode(env, 'meta_ads_vladimir'), null);
});

test('Meta HTTP errors distinguish retryable from terminal failures', () => {
  assert.equal(__testing.classifyHttpFailure(429).retryable, true);
  assert.equal(__testing.classifyHttpFailure(503).retryable, true);
  assert.equal(__testing.classifyHttpFailure(401).retryable, false);
  assert.equal(__testing.classifyHttpFailure(403).retryable, false);
  assert.equal(__testing.classifyHttpFailure(400).retryable, false);
});

test('claimed jobs fail closed on artist/config/event mismatch', () => {
  const base = {
    outbox_id: '11111111-1111-4111-8111-111111111111',
    artist_id: '22222222-2222-4222-8222-222222222222',
    enquiry_id: '33333333-3333-4333-8333-333333333333',
    project_id: null,
    attempt_count: 0,
    max_attempts: 8,
    event_name: 'Lead',
    event_id: '44444444-4444-4444-8444-444444444444',
    event_time: 1789400000,
    integration_key: 'meta_ads_vladimir',
    dataset_id: '1729215778134902',
    graph_api_version: 'v26.0',
    event_source_url: 'https://vishartattoo.com/booking/',
    fbp: null,
    fbc: null,
    email: 'user@example.com',
    phone: null,
    job_valid: true,
  };
  assert.equal(__testing.validateClaimedJob(base).event_name, 'Lead');
  assert.throws(() => __testing.validateClaimedJob({ ...base, job_valid: false }));
  assert.throws(() => __testing.validateClaimedJob({ ...base, graph_api_version: 'v25.0' }));
  assert.throws(() => __testing.validateClaimedJob({ ...base, integration_key: 'meta_ads_kristina', job_valid: false }));
});

test('Graph API version remains pinned to audited production contract', () => {
  assert.equal(META_ADS_CONFIG.graphApiVersion, 'v26.0');
});
