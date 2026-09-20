// The invoices raised on one project, and the button that raises another.
//
// Deliberately thin: it lists and it creates a draft. Everything an invoice can
// then become - line items, issue, payments, credit notes - happens on the
// invoice's own screen, so there is one place those rules are written down.

import { useState } from 'react';
import { useAsync } from './AsyncData';
import { EmptyState } from './StateViews';
import { formatDate, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { invoiceStatusLabel, type InvoiceSummary } from '../lib/invoice-api';
import { Link, useRouter } from '../lib/router';
import { useApi } from '../lib/session';
import '../pages/InvoicesPage.css';

export function ProjectInvoicesPanel({
  projectId,
  currency,
  mayManage,
}: {
  projectId: string;
  currency: string;
  mayManage: boolean;
}) {
  const api = useApi();
  const { navigate } = useRouter();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync<InvoiceSummary[]>(
    () => api.listInvoices({ projectId }),
    [api, projectId]
  );

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createInvoice({ projectId });
      reload();
      navigate(`/invoices/${result.invoice_id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.createFailed);
    } finally {
      setBusy(false);
    }
  }

  const invoices = data ?? [];

  return (
    <>
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
      {loading ? <p className="meta">{copy.loading}</p> : null}
      {!loading && invoices.length === 0 ? <EmptyState compact title={copy.none} /> : null}
      {invoices.length > 0 ? (
        <div className="invoice-list">
          {invoices.map((invoice) => (
            <div className="row" key={invoice.id}>
              <div className="title">
                <Link to={`/invoices/${invoice.id}`}>{invoice.invoice_number}</Link>
              </div>
              <div className="meta">
                <span className={invoice.is_overdue ? 'badge warn' : 'badge'}>
                  {invoiceStatusLabel(invoice.status, invoice.is_overdue, language)}
                </span>{' '}
                <span className="badge">
                  {copy.total}: {formatMoney(invoice.total, invoice.currency, language)}
                </span>{' '}
                <span className={invoice.amount_outstanding > 0 ? 'badge warn' : 'badge ok'}>
                  {copy.outstanding}: {formatMoney(invoice.amount_outstanding, invoice.currency, language)}
                </span>
              </div>
              <div className="meta">
                {invoice.issue_date ? `${copy.issued} ${formatDate(invoice.issue_date, language)}` : copy.draft}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {mayManage ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => { void create(); }}>
            {busy ? copy.creating : copy.create}
          </button>
          <span className="meta">{copy.currencyNote.replace('{currency}', currency)}</span>
        </div>
      ) : null}
    </>
  );
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    loading: 'Loading invoices…',
    none: 'No invoices on this project',
    create: 'New invoice',
    creating: 'Creating…',
    createFailed: 'Could not create that invoice.',
    total: 'Total',
    outstanding: 'Outstanding',
    issued: 'Issued',
    draft: 'Draft',
    currencyNote: 'Raised in {currency}.',
  },
  ru: {
    loading: 'Загрузка счетов…',
    none: 'По этому проекту счетов нет',
    create: 'Новый счёт',
    creating: 'Создаём…',
    createFailed: 'Не удалось создать счёт.',
    total: 'Итого',
    outstanding: 'К оплате',
    issued: 'Выставлен',
    draft: 'Черновик',
    currencyNote: 'Валюта: {currency}.',
  },
};
