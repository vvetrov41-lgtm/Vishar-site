const TOKEN_ENVELOPE_VERSION = 1;
const ALIASES = new Set(['vladimir', 'kristina']);
const CONNECTION_STATES = new Set([
  'oauth_authorized',
  'approval_pending',
  'account_selected',
  'webhook_registered',
  'reauthorization_required',
]);
const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9]+$/;
const WEBHOOK_ID_PATTERN = /^webhook_[A-Za-z0-9]+$/;
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PROVIDER_ACCOUNT_KEY_PATTERN = /^[a-z][a-z0-9_-]{2,79}$/;

export class MonzoTokenError extends Error {
  constructor(code = 'monzo_token_invalid') {
    super(code);
    this.name = 'MonzoTokenError';
    this.code = code;
  }
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlBytes(value) {
  if (typeof value !== 'string' || !value) throw new MonzoTokenError();
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new MonzoTokenError();
  }
}

function decodeEncryptionKey(value) {
  const bytes = base64UrlBytes(value);
  if (bytes.length !== 32) throw new MonzoTokenError('monzo_encryption_key_invalid');
  return bytes;
}

async function encryptionKey(value, usages) {
  return crypto.subtle.importKey(
    'raw',
    decodeEncryptionKey(value),
    'AES-GCM',
    false,
    usages,
  );
}

function cleanLabel(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new MonzoTokenError();
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!label || label.length > 120) throw new MonzoTokenError();
  return label;
}

function validateRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || !ALIASES.has(record.alias)
    || !CONNECTION_STATES.has(record.connectionState)
    || typeof record.artistId !== 'string'
    || !record.artistId
    || typeof record.providerAccountKey !== 'string'
    || !PROVIDER_ACCOUNT_KEY_PATTERN.test(record.providerAccountKey)
    || typeof record.clientId !== 'string'
    || !record.clientId
    || typeof record.userId !== 'string'
    || !record.userId
    || typeof record.accessToken !== 'string'
    || !record.accessToken
    || typeof record.refreshToken !== 'string'
    || !record.refreshToken
    || !Number.isFinite(record.expiresAt)
    || record.expiresAt <= 0
    || typeof record.connectedAt !== 'string'
    || !record.connectedAt
  ) {
    throw new MonzoTokenError();
  }

  if (record.accountId != null && !ACCOUNT_ID_PATTERN.test(record.accountId)) {
    throw new MonzoTokenError();
  }
  if (record.webhookId != null && !WEBHOOK_ID_PATTERN.test(record.webhookId)) {
    throw new MonzoTokenError();
  }
  if (record.webhookKey != null && !WEBHOOK_KEY_PATTERN.test(record.webhookKey)) {
    throw new MonzoTokenError();
  }
  if (record.accountId && !cleanLabel(record.accountLabel)) throw new MonzoTokenError();
  if (record.webhookId && (!record.accountId || !record.webhookKey)) throw new MonzoTokenError();
  if (record.connectionState === 'account_selected' && !record.accountId) throw new MonzoTokenError();
  if (record.connectionState === 'webhook_registered' && !record.webhookId) throw new MonzoTokenError();

  return {
    ...record,
    accountLabel: cleanLabel(record.accountLabel),
  };
}

export async function encryptMonzoTokenRecord(record, encryptionSecret) {
  const safeRecord = validateRecord(record);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(encryptionSecret, ['encrypt']),
    new TextEncoder().encode(JSON.stringify(safeRecord)),
  );
  return JSON.stringify({
    v: TOKEN_ENVELOPE_VERSION,
    iv: base64Url(iv),
    data: base64Url(new Uint8Array(encrypted)),
  });
}

export async function decryptMonzoTokenRecord(rawEnvelope, encryptionSecret) {
  let envelope;
  try {
    envelope = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
  } catch {
    throw new MonzoTokenError();
  }
  if (
    envelope?.v !== TOKEN_ENVELOPE_VERSION
    || typeof envelope.iv !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    throw new MonzoTokenError();
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlBytes(envelope.iv) },
      await encryptionKey(encryptionSecret, ['decrypt']),
      base64UrlBytes(envelope.data),
    );
    return validateRecord(JSON.parse(new TextDecoder().decode(decrypted)));
  } catch (error) {
    if (error instanceof MonzoTokenError) throw error;
    throw new MonzoTokenError();
  }
}

export function monzoTokenKey(artistId) {
  if (typeof artistId !== 'string' || !artistId) throw new MonzoTokenError();
  return `artist:${artistId}`;
}

export async function loadMonzoTokenRecord(env, artistId) {
  if (!env?.MONZO_OAUTH_TOKENS || !env?.MONZO_TOKEN_ENCRYPTION_KEY) {
    throw new MonzoTokenError('monzo_not_configured');
  }
  const raw = await env.MONZO_OAUTH_TOKENS.get(monzoTokenKey(artistId));
  if (!raw) throw new MonzoTokenError('monzo_not_connected');
  const record = await decryptMonzoTokenRecord(raw, env.MONZO_TOKEN_ENCRYPTION_KEY);
  if (record.artistId !== artistId) throw new MonzoTokenError('monzo_token_invalid');
  return record;
}

export async function saveMonzoTokenRecord(env, record) {
  if (!env?.MONZO_OAUTH_TOKENS || !env?.MONZO_TOKEN_ENCRYPTION_KEY) {
    throw new MonzoTokenError('monzo_not_configured');
  }
  const envelope = await encryptMonzoTokenRecord(record, env.MONZO_TOKEN_ENCRYPTION_KEY);
  await env.MONZO_OAUTH_TOKENS.put(monzoTokenKey(record.artistId), envelope);
  return validateRecord(record);
}

export async function deleteMonzoTokenRecord(env, artistId) {
  if (!env?.MONZO_OAUTH_TOKENS) throw new MonzoTokenError('monzo_not_configured');
  await env.MONZO_OAUTH_TOKENS.delete(monzoTokenKey(artistId));
}

export const __testing = {
  CONNECTION_STATES,
  validateRecord,
};
