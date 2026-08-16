(() => {
  'use strict';
  const APP_ID = '1481226093843982';
  const CONFIG_ID = '4468652066715473';
  const button = document.getElementById('connect');
  const status = document.getElementById('status');
  const allowedOrigins = new Set([
    'https://www.facebook.com',
    'https://web.facebook.com',
    'https://m.facebook.com'
  ]);
  let embeddedEvent = null;

  function setStatus(message) {
    status.textContent = message;
  }

  window.addEventListener('message', (event) => {
    if (!allowedOrigins.has(event.origin)) return;
    let payload = event.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return; }
    }
    if (!payload || typeof payload !== 'object' || payload.type !== 'WA_EMBEDDED_SIGNUP') return;
    embeddedEvent = typeof payload.event === 'string' ? payload.event : null;
    if (embeddedEvent === 'FINISH') setStatus('Meta Embedded Signup finished. Return to ChatGPT.');
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
      // The one-time code is intentionally not displayed, logged or persisted by this validation harness.
      // FINISH is a separate WA_EMBEDDED_SIGNUP postMessage event and is the signal that onboarding completed.
      if (embeddedEvent === 'FINISH') {
        setStatus('Meta Embedded Signup finished. Return to ChatGPT.');
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
