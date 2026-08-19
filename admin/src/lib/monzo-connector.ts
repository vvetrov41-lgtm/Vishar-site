import type { CrmRole } from './types';

// Must stay identical to the Monzo Worker artist registry
// (workers/lib/monzo-artist-registry.js). The CRM only launches the
// owner-protected setup route; the Worker remains the authority for artist
// identity, provider account key and OAuth client.
export const MONZO_CONNECTOR_ALIASES = ['vladimir', 'kristina'] as const;

export type MonzoConnectorAlias = (typeof MONZO_CONNECTOR_ALIASES)[number];

function isHostedMonzoConnectorHost(hostname: string): boolean {
  const labels = hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'vishartattoo' || labels[2] !== 'com') return false;
  return /^monzo(?:-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/.test(labels[0]);
}

export function readMonzoConnectorOrigin(
  env: Record<string, string | undefined>,
  allowLocal = false,
): string {
  const value = (env.VITE_MONZO_CONNECTOR_ORIGIN ?? '').trim();
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_MONZO_CONNECTOR_ORIGIN must be a permitted Monzo connector root URL.');
  }

  const loopback = allowLocal
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  const hosted = parsed.protocol === 'https:'
    && isHostedMonzoConnectorHost(parsed.hostname)
    && !parsed.port;

  if (
    (!hosted && !loopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('VITE_MONZO_CONNECTOR_ORIGIN must be a permitted Monzo connector root URL.');
  }

  return parsed.origin;
}

export function monzoConnectorAlias(value: string | null | undefined): MonzoConnectorAlias | null {
  return MONZO_CONNECTOR_ALIASES.includes(value as MonzoConnectorAlias)
    ? (value as MonzoConnectorAlias)
    : null;
}

export function monzoSetupUrl(origin: string, alias: MonzoConnectorAlias): string {
  if (!origin) throw new Error('Monzo connector is not configured.');
  return `${origin}/oauth/monzo/setup/${alias}`;
}

export function canManageMonzoConnection(role: CrmRole | null | undefined): boolean {
  return role === 'owner';
}

// The display name always comes from the selected CRM artist record, so no
// artist name is hardcoded in the connector surface.
export function monzoConnectionResultNotice(
  search: string,
  selectedAlias: MonzoConnectorAlias,
  artistDisplayName: string,
): string | null {
  const params = new URLSearchParams(search);
  const result = params.get('monzo');
  const artist = params.get('artist');
  if (artist !== selectedAlias) return null;

  const name = artistDisplayName.trim();
  if (!name) return null;
  if (result === 'authorized') {
    return `${name}’s Monzo login is authorised. If Monzo asks for approval in the app, approve it there, then open Manage Monzo connection to select the receiving account.`;
  }
  if (result === 'connected') {
    return `${name}’s Monzo account connection is active.`;
  }
  if (result === 'disconnected') {
    return `${name}’s Monzo account connection is disconnected.`;
  }
  return null;
}
