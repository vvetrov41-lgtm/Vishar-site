// Presentation helpers.

import type { Language } from './i18n';

const DATE_TIME: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }),
  ru: new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }),
};

const DATE_ONLY: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  ru: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }),
};

export function formatDateTime(value: string | null | undefined, language: Language = 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME[language].format(date);
}

export function formatDate(value: string | null | undefined, language: Language = 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY[language].format(date);
}

/**
 * Money is formatted from the currency stored on the row. The code is never
 * assumed: a project in another currency renders in that currency.
 */
export function formatMoney(
  amount: number | null | undefined,
  currency: string,
  language: Language = 'en'
): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(language === 'ru' ? 'ru-RU' : 'en-GB', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function relativeDue(
  value: string,
  now = new Date(),
  language: Language = 'en'
): { label: string; overdue: boolean } {
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return { label: '—', overdue: false };
  const diffDays = Math.round((due.getTime() - now.getTime()) / 86400000);

  if (language === 'ru') {
    if (diffDays < 0) return { label: `Просрочено на ${Math.abs(diffDays)} дн.`, overdue: true };
    if (diffDays === 0) return { label: 'Срок сегодня', overdue: false };
    if (diffDays === 1) return { label: 'Срок завтра', overdue: false };
    return { label: `Срок через ${diffDays} дн.`, overdue: false };
  }

  if (diffDays < 0) return { label: `${Math.abs(diffDays)}d overdue`, overdue: true };
  if (diffDays === 0) return { label: 'Due today', overdue: false };
  if (diffDays === 1) return { label: 'Due tomorrow', overdue: false };
  return { label: `Due in ${diffDays}d`, overdue: false };
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}
