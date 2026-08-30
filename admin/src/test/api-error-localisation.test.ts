// Failure messages an operator can act on, in their own language.
//
// Every read and write funnels through friendlyMessage(). It used to compose
// one English sentence - "Could not load clients. Please try again." - which
// was wrong twice over inside a Russian interface: it was English, and it left
// the only urgent question unanswered. After a failed deposit request the
// operator needs to know whether the money was recorded before deciding
// whether to try again.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_OPERATIONS, describeApiFailure, type ApiOperation } from '../lib/api-errors';
import { friendlyMessage } from '../lib/api';

const DENIED = { code: '42501', message: 'permission denied for table clients' };
const BROKEN = { code: 'PGRST000', message: 'FetchError: network request failed' };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('operation dictionary', () => {
  it('translates every operation the interface can fail at', () => {
    const entries = Object.entries(API_OPERATIONS);
    expect(entries.length).toBeGreaterThan(100);
    for (const [phrase, operation] of entries) {
      expect(operation.ru, `${phrase} has no Russian phrase`).not.toBe('');
      // A Cyrillic-free translation means the English leaked into the map.
      expect(operation.ru, `${phrase} was not translated`).toMatch(/[а-яё]/i);
      expect(['read', 'write']).toContain(operation.kind);
    }
  });

  it('classifies a write as a write, so the message can say what happened to the data', () => {
    expect(API_OPERATIONS['request that deposit'].kind).toBe('write');
    expect(API_OPERATIONS['confirm that Monzo payment'].kind).toBe('write');
    expect(API_OPERATIONS['load clients'].kind).toBe('read');
    expect(API_OPERATIONS['check appointment conflicts'].kind).toBe('read');
  });
});

describe('failure sentences', () => {
  it('tells a Russian operator that a failed write saved nothing', () => {
    const message = describeApiFailure(BROKEN, 'request that deposit', 'ru');
    expect(message).toBe(
      'Не удалось запросить депозит. Изменения не сохранены — попробуйте ещё раз.'
    );
  });

  it('asks a Russian operator to reload rather than to retry, when a read fails', () => {
    const message = describeApiFailure(BROKEN, 'load clients', 'ru');
    expect(message).toBe(
      'Не удалось загрузить клиентов. Данные не загружены — проверьте соединение и обновите страницу.'
    );
  });

  it('names who can grant access when the database refuses', () => {
    expect(describeApiFailure(DENIED, 'request that deposit', 'ru')).toBe(
      'Недостаточно прав, чтобы запросить депозит. Изменения не сохранены — попросите владельца студии открыть доступ.'
    );
    expect(describeApiFailure(DENIED, 'load clients', 'en')).toBe(
      'You do not have permission to load clients. Ask the studio owner for access.'
    );
  });

  it('keeps a deliberate workflow guard from the database instead of replacing it', () => {
    // These are written for the operator ("that status change is not allowed"),
    // so a generic failure would drop the only useful part of the answer.
    const guard = { code: 'P0001', message: 'Transition to converted is not allowed' };
    expect(describeApiFailure(guard, 'change that status', 'ru'))
      .toBe('Transition to converted is not allowed');
  });

  it('never leaks a PostgREST code, an RPC name or an HTTP status', () => {
    const raw = {
      code: '23503',
      message: 'insert or update on table "payment_requests" violates foreign key constraint',
      details: 'Key (session_id)=(…) is not present in table "appointments".',
    };
    for (const language of ['en', 'ru'] as const) {
      const message = describeApiFailure(raw, 'request that deposit', language);
      expect(message).not.toContain('23503');
      expect(message).not.toContain('payment_requests');
      expect(message).not.toContain('foreign key');
    }
  });

  it('answers in the language the interface is showing', () => {
    window.localStorage.setItem('vishar-crm-language', 'ru');
    // friendlyMessage reads the stored preference, because the API modules have
    // no React context of their own.
    expect(friendlyMessage(BROKEN, 'load clients')).toMatch(/^Не удалось/);
  });

  it('handles an error that is not an object at all', () => {
    for (const value of [null, undefined, 'boom', 42]) {
      expect(describeApiFailure(value, 'load clients' as ApiOperation, 'en'))
        .toBe('Could not load clients. Nothing was loaded — check your connection and reload.');
    }
  });
});
