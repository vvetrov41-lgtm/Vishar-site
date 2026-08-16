import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_ALLOWED_MESSAGE_ORIGINS,
  parseEmbeddedSignupMessage,
} from '../lib/meta-whatsapp-embedded-signup';

describe('Meta WhatsApp Embedded Signup event boundary', () => {
  it('accepts the exact desktop, web and mobile Facebook origins', () => {
    expect([...FACEBOOK_ALLOWED_MESSAGE_ORIGINS].sort()).toEqual([
      'https://m.facebook.com',
      'https://web.facebook.com',
      'https://www.facebook.com',
    ]);
  });

  it('extracts WABA and phone-number ids only from a FINISH event', () => {
    expect(parseEmbeddedSignupMessage('https://m.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '12345678901', phone_number_id: '10987654321' },
    })).toEqual({
      event: 'FINISH',
      wabaId: '12345678901',
      phoneNumberId: '10987654321',
    });
  });

  it('rejects spoofed origins and malformed provider ids', () => {
    expect(parseEmbeddedSignupMessage('https://evil.example', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '12345678901', phone_number_id: '10987654321' },
    })).toBeNull();

    expect(parseEmbeddedSignupMessage('https://www.facebook.com', JSON.stringify({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '../bad', phone_number_id: 'phone' },
    }))).toEqual({ event: 'FINISH', wabaId: null, phoneNumberId: null });
  });

  it('preserves CANCEL and ERROR as terminal Meta events', () => {
    expect(parseEmbeddedSignupMessage('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: {},
    })).toEqual({ event: 'CANCEL', wabaId: null, phoneNumberId: null });
    expect(parseEmbeddedSignupMessage('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: {},
    })).toEqual({ event: 'ERROR', wabaId: null, phoneNumberId: null });
  });
});
