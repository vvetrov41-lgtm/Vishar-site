import { describe, expect, it } from 'vitest';
import { __testing } from './provision.js';

describe('Kristina standalone WhatsApp provisioning boundary', () => {
  it('is hard-scoped to Kristina production route and binding', () => {
    expect(Object.keys(__testing.APPROVED_ARTISTS)).toEqual([
      'a2222222-2222-4222-8222-222222222222',
    ]);
    expect(__testing.APPROVED_ARTISTS['a2222222-2222-4222-8222-222222222222']).toEqual({
      integrationKey: 'kristina-production',
      bindingName: 'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION',
    });
  });

  it('discovers only WhatsApp Business Management target ids and de-duplicates them', () => {
    expect(__testing.extractUniqueWhatsappTargetIds({
      granular_scopes: [
        {
          scope: 'whatsapp_business_management',
          target_ids: ['12345678901', '12345678901', 'invalid'],
        },
        {
          scope: 'whatsapp_business_messaging',
          target_ids: ['99999999999'],
        },
      ],
    })).toEqual(['12345678901']);
  });

  it('ignores malformed or missing granular scopes', () => {
    expect(__testing.extractUniqueWhatsappTargetIds(null)).toEqual([]);
    expect(__testing.extractUniqueWhatsappTargetIds({ granular_scopes: 'bad' })).toEqual([]);
  });

  it('generates an opaque webhook verification token without exposing credentials', () => {
    const left = __testing.randomVerifyToken();
    const right = __testing.randomVerifyToken();
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(right).toMatch(/^[0-9a-f]{64}$/);
    expect(left).not.toBe(right);
  });
});
