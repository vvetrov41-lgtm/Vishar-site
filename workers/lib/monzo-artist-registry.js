// Single source of truth for which artists the Monzo runtime can route.
//
// Onboarding another artist is a configuration change, not an engineering
// project: add one entry here plus the artist-id binding in the Worker
// configuration. Nothing else in the Monzo runtime may hardcode an artist.
//
// OAuth credentials are shared by default. Monzo issues one access/refresh
// token per (confidential client, Monzo user), so one Vishar CRM client can
// serve every artist while each artist keeps its own token envelope, selected
// account, webhook route and provider account key. The per-artist override
// bindings exist only so that a future artist-specific client is a
// configuration change rather than a rewrite; they are unset in production.

const SHARED_CLIENT_ID_BINDING = 'MONZO_OAUTH_CLIENT_ID';
const SHARED_CLIENT_SECRET_BINDING = 'MONZO_OAUTH_CLIENT_SECRET';

function entry(alias, displayName) {
  const suffix = alias.toUpperCase();
  return Object.freeze({
    alias,
    displayName,
    artistIdBinding: `${suffix}_ARTIST_ID`,
    oauthClientIdBinding: `${SHARED_CLIENT_ID_BINDING}_${suffix}`,
    oauthClientSecretBinding: `${SHARED_CLIENT_SECRET_BINDING}_${suffix}`,
  });
}

export const MONZO_ARTIST_REGISTRY = Object.freeze([
  entry('vladimir', 'Vladimir'),
  entry('kristina', 'Kristina'),
]);

const BY_ALIAS = new Map(MONZO_ARTIST_REGISTRY.map((item) => [item.alias, item]));

export const MONZO_ARTIST_ALIASES = Object.freeze(
  MONZO_ARTIST_REGISTRY.map((item) => item.alias),
);

export function isMonzoArtistAlias(alias) {
  return typeof alias === 'string' && BY_ALIAS.has(alias);
}

export function monzoArtistEntry(alias) {
  return isMonzoArtistAlias(alias) ? BY_ALIAS.get(alias) : null;
}

export function monzoArtistDisplayName(alias) {
  return monzoArtistEntry(alias)?.displayName ?? '';
}

// Path fragment for the owner-protected artist-scoped routes. Built from the
// registry so a new alias cannot be reachable in one place and unreachable in
// another.
export function monzoAliasPathPattern() {
  return `(${MONZO_ARTIST_ALIASES.join('|')})`;
}

export function monzoArtistIdFromEnv(alias, env) {
  const item = monzoArtistEntry(alias);
  if (!item) return '';
  return String(env?.[item.artistIdBinding] || '').trim();
}

// Resolve the OAuth client for one artist: an explicit per-artist override
// when both halves are configured, otherwise the shared Vishar CRM client.
// A half-configured override is a configuration error and must never silently
// fall back to the shared secret with the wrong client id.
export function monzoArtistOAuthCredentials(alias, env) {
  const item = monzoArtistEntry(alias);
  if (!item) return { clientId: '', clientSecret: '', scoped: false };

  const overrideId = String(env?.[item.oauthClientIdBinding] || '').trim();
  const overrideSecret = String(env?.[item.oauthClientSecretBinding] || '').trim();
  if (overrideId || overrideSecret) {
    if (!overrideId || !overrideSecret) return { clientId: '', clientSecret: '', scoped: true };
    return { clientId: overrideId, clientSecret: overrideSecret, scoped: true };
  }

  return {
    clientId: String(env?.[SHARED_CLIENT_ID_BINDING] || '').trim(),
    clientSecret: String(env?.[SHARED_CLIENT_SECRET_BINDING] || '').trim(),
    scoped: false,
  };
}

// An env view whose OAuth client bindings are already resolved for one artist.
// Every Monzo provider call goes through this so the provider client itself
// stays credential-agnostic.
export function monzoArtistOAuthEnv(alias, env) {
  const { clientId, clientSecret } = monzoArtistOAuthCredentials(alias, env);
  return {
    ...env,
    [SHARED_CLIENT_ID_BINDING]: clientId,
    [SHARED_CLIENT_SECRET_BINDING]: clientSecret,
  };
}

export const __testing = {
  SHARED_CLIENT_ID_BINDING,
  SHARED_CLIENT_SECRET_BINDING,
};
