// Private Supabase Storage operations.
//
// Objects only ever land at a canonical path the database produced. The Worker
// does not build paths, and nothing a visitor sends influences one.
//
// Signed URLs are minted per request, short-lived, never logged and never
// persisted. No public URL is ever created: the bucket is private.

import { statusClass } from './logging.js';

export const BUCKET = 'crm-files';

/** Signed reads are deliberately short. A CRM screen re-mints as it renders. */
export const DEFAULT_SIGNED_URL_SECONDS = 60;

const CANONICAL_PATH = new RegExp(
  '^clients/[0-9a-f-]{36}/(' +
    'enquiries/[0-9a-f-]{36}/references|' +
    'projects/[0-9a-f-]{36}/(designs|sessions|healed)' +
  ')/[0-9a-f-]{36}\\.(jpg|jpeg|png|webp)$'
);

export class StorageError extends Error {
  constructor(operation, status) {
    super(`storage ${operation} failed (${statusClass(status)})`);
    this.name = 'StorageError';
    this.code = 'storage_unavailable';
    this.operation = operation;
    this.status = status;
  }
}

/**
 * Last line of defence before an upload. The database already proved the path
 * is canonical for its row; this catches a Worker-side mistake before it can
 * write an object outside the layout.
 */
export function isCanonicalPath(path) {
  return typeof path === 'string' && CANONICAL_PATH.test(path);
}

export function createStorageClient(supabase, fetchImpl = fetch) {
  const base = `${supabase.url}/storage/v1`;
  const authHeaders = { ...supabase.authHeaders };

  async function upload(path, bytes, contentType) {
    if (!isCanonicalPath(path)) {
      throw new StorageError('upload', 400);
    }

    const response = await fetchImpl(`${base}/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=0, no-store',
        'x-upsert': 'true',
      },
      body: bytes,
    });

    if (!response.ok) {
      throw new StorageError('upload', response.status);
    }
  }

  /**
   * Compensating delete. Returns a boolean rather than throwing: this runs on
   * the failure path, and a failed cleanup must not mask the original error.
   * A failed delete remains an orphan until the planned object-sweep job is
   * implemented; the current intake reconciliation only inspects database
   * manifests and never claims to clean untracked Storage objects.
   */
  async function remove(path) {
    try {
      const response = await fetchImpl(`${base}/object/${BUCKET}/${path}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function createSignedUrl(path, expiresIn = DEFAULT_SIGNED_URL_SECONDS) {
    const response = await fetchImpl(`${base}/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });

    if (!response.ok) {
      throw new StorageError('sign', response.status);
    }

    const body = await response.json();
    const signed = typeof body?.signedURL === 'string' ? body.signedURL : '';
    if (!signed) throw new StorageError('sign', 502);

    return `${base}${signed.startsWith('/') ? '' : '/'}${signed}`;
  }

  return { upload, remove, createSignedUrl };
}
