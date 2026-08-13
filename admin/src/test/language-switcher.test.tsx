import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { LanguageProvider, useLanguage } from '../lib/i18n';

function Probe() {
  const { t } = useLanguage();
  return <div>{t('nav.enquiries')}</div>;
}

describe('CRM language switcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'en';
  });

  it('switches the interface to Russian and remembers the choice', async () => {
    render(
      <LanguageProvider>
        <LanguageSwitcher />
        <Probe />
      </LanguageProvider>
    );

    const selector = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(selector, { target: { value: 'ru' } });

    expect(screen.getByText('Заявки')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Язык' })).toHaveValue('ru');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ru');
      expect(window.localStorage.getItem('vishar-crm-language')).toBe('ru');
    });
  });
});
