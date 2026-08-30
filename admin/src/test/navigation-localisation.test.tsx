// Navigation labels must come from the dictionary.
//
// translate() returns the key it was given when that key is not in the
// dictionary. NAV_ITEMS carries an English `label` as its fallback key, so a
// destination missing from NAV_KEYS rendered its English label inside the
// Russian interface. Communications and Payments both did.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { NAV_ITEMS } from '../lib/permissions';
import { LanguageProvider, translate } from '../lib/i18n';
import { KRISTINA_ARTIST_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('vishar-crm-language', 'ru');
});

afterEach(() => {
  window.localStorage.clear();
});

describe('navigation localisation', () => {
  it('has a Russian and English label for every navigation destination', () => {
    for (const item of NAV_ITEMS) {
      for (const language of ['en', 'ru'] as const) {
        const key = `nav.${item.path === '/' ? 'dashboard' : item.path.replace(/^\//, '').replace(/\//g, '.')}`;
        const translated = translate(language, key);
        expect(translated, `${key} is missing from the ${language} dictionary`).not.toBe(key);
      }
    }
  });

  it('never renders a raw dictionary key or an English fallback in the Russian sidebar', async () => {
    // renderWithSession supplies session and router only; the language comes
    // from the provider, which reads the stored preference set above.
    const { container } = renderWithSession(
      <LanguageProvider><App /></LanguageProvider>,
      {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
      }
    );

    await screen.findByRole('heading', { level: 2, name: 'Заявки' });

    const sidebar = container.querySelector('.sidebar-nav') as HTMLElement;
    const labels = within(sidebar)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim() ?? '');

    expect(labels).toContain('Сообщения');
    expect(labels).toContain('Платежи');
    expect(labels).toContain('Записи');
    expect(labels).toContain('Выходные');
    expect(labels).toContain('Автоматизации');

    // The exact strings that used to leak, plus anything still key-shaped.
    expect(labels).not.toContain('Communications');
    expect(labels).not.toContain('Payments');
    for (const label of labels) {
      expect(label, `${label} looks like an untranslated key`).not.toMatch(/^nav\./);
    }
  });

  it('keeps the English labels unchanged', async () => {
    window.localStorage.setItem('vishar-crm-language', 'en');
    const { container } = renderWithSession(
      <LanguageProvider><App /></LanguageProvider>,
      {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      }
    );

    await screen.findByRole('heading', { level: 2, name: 'Enquiries' });

    const sidebar = container.querySelector('.sidebar-nav') as HTMLElement;
    const labels = within(sidebar)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim() ?? '');

    expect(labels).toContain('Communications');
    expect(labels).toContain('Payments');
    expect(labels).toContain('Appointments');
    expect(labels).toContain('Time off');
    expect(labels).toContain('Automations');
  });
});
