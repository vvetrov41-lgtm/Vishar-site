(() => {
  'use strict';
  const APP_ID = '1481226093843982';
  const CONFIG_ID = '4468652066715473';
  const EXCHANGE_PATH = '/api/whatsapp/embedded-signup/exchange';
  const button = document.getElementById('connect');
  const status = document.getElementById('status');
  const allowedOrigins = new Set([
    'https://www.facebook.com',
    'https://web.facebook.com',
    'https://m.facebook.com'
  ]);
  let embeddedEvent = null;
  let pendingCode = null;
  let sessionInfo = {};
  let exchanging = false;

  function setStatus(message) {
    status.textContent = message;
  }

  function numericId(value) {
    return typeof value === 'string' && /^[0-9]{5,30}$/.test(value) ? value : null;
  }

  function sanitizeSession(data) {
    if (!data || typeof data !== 'object') return {};
    return {
      waba_id: numericId(data.waba_id),
      phone_number_id: numericId(data.phone_number_id)
    };
  }

  function describeVerifiedAccount(result) {
    const wabaName = result && result.waba && typeof result.waba.name === 'string'
      ? result.waba.name
      : null;
    const phones = result && Array.isArray(result.phones)
      ? result.phones.filter((item) => item && typeof item.display_phone_number === 'string')
      : [];
    const phoneText = phones.length
      ? phones.map((item) => item.display_phone_number).join(', ')
      : null;
    if (wabaName && phoneText) return `Verified WABA: ${wabaName}. Phone: ${phoneText}. Return to ChatGPT.`;
    if (wabaName) return `Verified WABA: ${wabaName}. Return to ChatGPT.`;
    return 'Meta Embedded Signup and server-side code exchange completed. Return to ChatGPT.';
  }

  async function completeExchangeIfReady() {
    if (embeddedEvent !== 'FINISH' || !pendingCode || exchanging) return;
    exchanging = true;
    button.disabled = true;
    setStatus('Meta onboarding finished. Verifying the selected WhatsApp account…');
    const code = pendingCode;
    pendingCode = null;
    try {
      const response = await fetch(EXCHANGE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, session: sessionInfo })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        if (result && result.error === 'server_secret_not_configured') {
          setStatus('Server-side Meta App Secret is not configured yet. Return to ChatGPT.');
        } else {
          setStatus('Meta onboarding finished, but server-side verification failed. Return to ChatGPT.');
        }
        return;
      }
      setStatus(describeVerifiedAccount(result));
    } catch {
      setStatus('Meta onboarding finished, but the staging verification endpoint could not be reached. Return to ChatGPT.');
    } finally {
      exchanging = false;
      button.disabled = false;
    }
  }

  window.addEventListener('message', (event) => {
    if (!allowedOrigins.has(event.origin)) return;
    let payload = event.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return; }
    }
    if (!payload || typeof payload !== 'object' || payload.type !== 'WA_EMBEDDED_SIGNUP') return;
    embeddedEvent = typeof payload.event === 'string' ? payload.event : null;
    if (embeddedEvent === 'FINISH') {
      sessionInfo = sanitizeSession(payload.data);
      setStatus('Meta Embedded Signup finished. Waiting for the authorization code…');
      void completeExchangeIfReady();
    }
    if (embeddedEvent === 'CANCEL') setStatus('Meta Embedded Signup was cancelled.');
    if (embeddedEvent === 'ERROR') setStatus('Meta reported an Embedded Signup error.');
  });

  window.fbAsyncInit = function () {
    if (!window.FB) {
      setStatus('Meta SDK did not initialise.');
      return;
    }
    window.FB.init({ appId: APP_ID, autoLogAppEvents: false, xfbml: false, version: 'v25.0' });
    button.disabled = false;
    button.textContent = 'Connect existing WhatsApp Business';
  };

  button.addEventListener('click', () => {
    if (!window.FB) {
      setStatus('Meta SDK is not ready yet.');
      return;
    }
    embeddedEvent = null;
    pendingCode = null;
    sessionInfo = {};
    button.disabled = true;
    setStatus('Opening Meta…');
    window.FB.login((response) => {
      button.disabled = false;
      if (!response || !response.authResponse || !response.authResponse.code) {
        if (embeddedEvent !== 'CANCEL' && embeddedEvent !== 'ERROR') {
          setStatus('Meta authorization was cancelled or did not return a code.');
        }
        return;
      }
      // Keep the one-time code only in page memory until FINISH, then send it once to the same-origin
      // staging verification endpoint. It is never displayed, logged, persisted or written to Supabase.
      pendingCode = response.authResponse.code;
      if (embeddedEvent === 'FINISH') {
        void completeExchangeIfReady();
      } else {
        setStatus('Meta returned the authorization code. Waiting for the Embedded Signup finish event…');
      }
    }, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3'
      }
    });
  });

  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.crossOrigin = 'anonymous';
  script.src = 'https://connect.facebook.net/en_US/sdk.js';
  script.onerror = () => setStatus('Could not load Meta SDK.');
  document.head.appendChild(script);
})();
