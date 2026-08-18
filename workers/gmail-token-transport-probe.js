const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DISCOVERY_ENDPOINT = 'https://accounts.google.com/.well-known/openid-configuration';

function classifyFetchError(error) {
  const name = error instanceof Error && error.name ? error.name : 'unknown';
  const message = error instanceof Error && typeof error.message === 'string' ? error.message.toLowerCase() : '';
  let kind = 'unknown';
  if (message.includes('redirect')) kind = 'redirect';
  else if (message.includes('dns')) kind = 'dns';
  else if (message.includes('tls') || message.includes('certificate')) kind = 'tls';
  else if (message.includes('network') || message.includes('connection')) kind = 'network';
  else if (message.includes('subrequest')) kind = 'subrequest';
  else if (message.includes('loop')) kind = 'loop';
  return { name, kind };
}

async function probeTokenEndpoint(redirectMode) {
  const body = new URLSearchParams({
    client_id: 'synthetic-client-id',
    client_secret: 'synthetic-client-secret',
    code: 'synthetic-authorization-code',
    redirect_uri: 'https://example.invalid/oauth/callback',
    grant_type: 'authorization_code',
  });

  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  };
  if (redirectMode !== 'default') init.redirect = redirectMode;

  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, init);
    let providerError = null;
    try {
      const json = await response.clone().json();
      const allowed = new Set([
        'invalid_client',
        'invalid_grant',
        'invalid_request',
        'unauthorized_client',
        'unsupported_grant_type',
      ]);
      if (typeof json?.error === 'string' && allowed.has(json.error)) providerError = json.error;
    } catch {
      // The probe reports only bounded response metadata.
    }
    return {
      transport: 'response',
      status: response.status,
      redirected: response.redirected,
      provider_error: providerError,
    };
  } catch (error) {
    return {
      transport: 'exception',
      error: classifyFetchError(error),
    };
  }
}

async function probeDiscoveryEndpoint() {
  try {
    const response = await fetch(GOOGLE_DISCOVERY_ENDPOINT, { redirect: 'manual' });
    return { transport: 'response', status: response.status, redirected: response.redirected };
  } catch (error) {
    return { transport: 'exception', error: classifyFetchError(error) };
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/probe') {
      return new Response('Not found', { status: 404 });
    }

    const [discovery, defaultRedirect, manualRedirect, errorRedirect] = await Promise.all([
      probeDiscoveryEndpoint(),
      probeTokenEndpoint('default'),
      probeTokenEndpoint('manual'),
      probeTokenEndpoint('error'),
    ]);

    return Response.json({
      discovery,
      token_default: defaultRedirect,
      token_manual: manualRedirect,
      token_error: errorRedirect,
    }, {
      headers: { 'cache-control': 'no-store' },
    });
  },
};
