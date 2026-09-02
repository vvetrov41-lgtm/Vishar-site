import { afterEach, describe, expect, it } from 'vitest';
import {
  META_WHATSAPP_CONFIG_ID,
  launchWhatsAppEmbeddedSignup,
  prepareWhatsAppEmbeddedSignup,
} from '../lib/meta-whatsapp-embedded-signup';

describe('Meta WhatsApp Embedded Signup v4 launch contract', () => {
  const originalFb = window.FB;
  const originalAsyncInit = window.fbAsyncInit;

  afterEach(() => {
    window.FB = originalFb;
    window.fbAsyncInit = originalAsyncInit;
  });

  it('keeps products and permissions in the Meta configuration and sends only the coexistence selector', async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    window.FB = {
      init() {},
      login(callback, options) {
        capturedOptions = options as unknown as Record<string, unknown>;
        callback({ status: 'not_authorized' });
      },
    };

    await prepareWhatsAppEmbeddedSignup();
    await expect(launchWhatsAppEmbeddedSignup()).rejects.toMatchObject({
      code: 'WA_META_LOGIN_NOT_AUTHORIZED',
    });

    expect(capturedOptions).toEqual({
      config_id: META_WHATSAPP_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        featureType: 'whatsapp_business_app_onboarding',
      },
    });
    expect(capturedOptions).not.toHaveProperty('extras.setup');
    expect(capturedOptions).not.toHaveProperty('extras.sessionInfoVersion');
    expect(capturedOptions).not.toHaveProperty('extras.version');
  });
});
