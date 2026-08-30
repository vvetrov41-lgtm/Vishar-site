// The sentences each API module states in its own words.
//
// friendlyMessage() covers the shared read/write path, but ten modules also
// throw their own literals: a malformed provider response, a misconfigured
// build, an expired session, a file the CRM will not accept. Seventy-nine of
// them were English, inside an interface the studio runs in Russian.

import { describe, expect, it } from 'vitest';
import { API_MESSAGES, translateApiMessage } from '../lib/api-errors';

// Read through Vite rather than node:fs, so the suite needs no Node types.
const LIB_SOURCES = import.meta.glob('../lib/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('module failure sentences', () => {
  it('translates every one of them', () => {
    const entries = Object.entries(API_MESSAGES);
    expect(entries.length).toBeGreaterThan(75);
    for (const [en, ru] of entries) {
      expect(ru, `${en} was not translated`).not.toBe(en);
      expect(ru, `${en} has no Cyrillic in its translation`).toMatch(/[а-яё]/i);
    }
  });

  it('answers in the language it is asked for', () => {
    expect(translateApiMessage('Could not load the inbox.', 'en')).toBe('Could not load the inbox.');
    expect(translateApiMessage('Could not load the inbox.', 'ru'))
      .toBe('Не удалось загрузить сообщения. Данные не загружены — проверьте соединение и обновите страницу.');
  });

  it('says whether the work landed, wherever a write can fail', () => {
    // The point of the exercise: an operator who sees a failure has to know
    // whether to press the button again.
    expect(translateApiMessage('Could not queue that reply.', 'ru')).toContain('не отправлено');
    expect(translateApiMessage('Could not create that enquiry.', 'ru')).toContain('не сохранены');
    expect(translateApiMessage('Could not transfer ownership.', 'ru')).toContain('не сохранены');
  });

  it('leaves no raw English literal behind in any API module', () => {
    // The type system stops an untranslated string reaching apiMessage(); this
    // stops one going around it. A new ApiError('…') has to be translated
    // first, exactly like the operation phrases.
    // Guard the guard: an empty glob would make this assertion vacuous.
    expect(Object.keys(LIB_SOURCES).length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const [path, text] of Object.entries(LIB_SOURCES)) {
      const name = path.split('/').pop() ?? path;
      // api-errors.ts is the dictionary itself.
      if (name === 'api-errors.ts') continue;
      for (const match of text.matchAll(/(?:new )?ApiError\(\s*'([^']+)'/g)) {
        offenders.push(`${name}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
