// Every invoice the signed-in account may see, newest first.

import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { formatDate, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import {
  INVOICE_STATUSES,
  invoiceStatusLabel,
  type InvoiceStatus,
  type InvoiceSummary,
} from '../lib/invoice-api';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import type { Client } from '../lib/types';
import './InvoicesPage.css';

type StatusFilter = InvoiceStatus | 'all';

export function InvoicesPage() {
  const api = useApi();
  const { selectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [status, setStatus] = useState<StatusFilter>('all');

  const { data, loading, error, reload } = useAsync<{ invoices: InvoiceSummary[]; clients: Client[] }>(
    async () => {
      const invoices = await api.listInvoices({
        artistId: selectedArtistId ?? null,
        status: status === 'all' ? null : status,
      });
      const clients = await api.listClientsByIds(invoices.map((invoice) => invoice.client_id));
      return { invoices, clients };
    },
    [api, selectedArtistId, status]
  );

  /**
   * One line per currency. Adding GBP100 to USD100 and calling the answer
   * GBP200 is worse than saying nothing, and the schema allows an artist in
   * another currency even though both artists are on GBP today.
   */
  const totals = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const invoice of data?.invoices ?? []) {
      byCurrency.set(
        invoice.currency,
        (byCurrency.get(invoice.currency) ?? 0) + invoice.amount_outstanding
      );
    }
    return [...byCurrency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, outstanding]) => ({ currency, outstanding }));
  }, [data?.invoices]);

  if (loading && !data) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const invoices = data?.invoices ?? [];

  return (
    <Section title={copy.title}>
      <div className="filters">
        <label>
          <span>{copy.filterStatus}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="all">{copy.allStatuses}</option>
            {INVOICE_STATUSES.map((option) => (
              <option key={option} value={option}>{invoiceStatusLabel(option, false, language)}</option>
            ))}
          </select>
        </label>
      </div>

      {invoices.length === 0 ? (
        <EmptyState title={copy.none} hint={copy.noneHint} />
      ) : (
        <>
          {totals.map((total) => (
            <p className="meta" key={total.currency}>
              {copy.outstandingTotal.replace(
                '{amount}',
                formatMoney(total.outstanding, total.currency, language)
              )}
            </p>
          ))}
          <div className="invoice-list">
            {invoices.map((invoice) => (
              <InvoiceListRow
                key={invoice.id}
                invoice={invoice}
                clientName={data?.clients.find((client) => client.id === invoice.client_id)?.full_name ?? null}
                language={language}
              />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

export function InvoiceListRow({
  invoice,
  clientName,
  language,
}: {
  invoice: InvoiceSummary;
  clientName: string | null;
  language: Language;
}) {
  const copy = COPY[language];
  return (
    <div className="row invoice-row">
      <div className="title">
        <Link to={`/invoices/${invoice.id}`}>{invoice.invoice_number}</Link>
      </div>
      <div className="meta">
        <span className={badgeClass(invoice)}>
          {invoiceStatusLabel(invoice.status, invoice.is_overdue, language)}
        </span>{' '}
        {clientName ? <span className="badge">{clientName}</span> : null}{' '}
        <span className="badge">{copy.total}: {formatMoney(invoice.total, invoice.currency, language)}</span>{' '}
        <span className="badge">{copy.paid}: {formatMoney(invoice.amount_paid, invoice.currency, language)}</span>{' '}
        {invoice.amount_credited > 0 ? (
          <span className="badge">{copy.credited}: {formatMoney(invoice.amount_credited, invoice.currency, language)}</span>
        ) : null}{' '}
        <span className={invoice.amount_outstanding > 0 ? 'badge warn' : 'badge ok'}>
          {copy.outstanding}: {formatMoney(invoice.amount_outstanding, invoice.currency, language)}
        </span>
      </div>
      <div className="meta">
        {invoice.issue_date ? `${copy.issued} ${formatDate(invoice.issue_date, language)}` : copy.notIssued}
        {invoice.due_date ? ` · ${copy.due} ${formatDate(invoice.due_date, language)}` : ''}
      </div>
    </div>
  );
}

function badgeClass(invoice: InvoiceSummary): string {
  if (invoice.status === 'paid') return 'badge ok';
  if (invoice.status === 'void') return 'badge';
  if (invoice.is_overdue) return 'badge warn';
  return 'badge';
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Invoices',
    loading: 'Loading invoices…',
    filterStatus: 'Filter by status',
    allStatuses: 'All statuses',
    none: 'No invoices yet',
    noneHint: 'Open a project and raise one there.',
    outstandingTotal: 'Outstanding across these invoices: {amount}',
    total: 'Total',
    paid: 'Paid',
    credited: 'Credited',
    outstanding: 'Outstanding',
    issued: 'Issued',
    notIssued: 'Not issued yet',
    due: 'due',
  },
  ru: {
    title: 'Счета',
    loading: 'Загрузка счетов…',
    filterStatus: 'Фильтр по статусу',
    allStatuses: 'Все статусы',
    none: 'Счетов пока нет',
    noneHint: 'Откройте проект и создайте счёт там.',
    outstandingTotal: 'К оплате по этим счетам: {amount}',
    total: 'Итого',
    paid: 'Оплачено',
    credited: 'Скорректировано',
    outstanding: 'К оплате',
    issued: 'Выставлен',
    notIssued: 'Ещё не выставлен',
    due: 'срок',
  },
};
