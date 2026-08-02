import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { Enquiry, EnquiryStatus } from '../lib/types';

const FILTERS: ('' | EnquiryStatus)[] = [
  '',
  'new',
  'reviewing',
  'waiting_for_client',
  'accepted',
  'quote_sent',
  'deposit_requested',
  'deposit_paid',
  'converted',
  'declined',
  'closed',
];

export function EnquiriesPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const [status, setStatus] = useState<'' | EnquiryStatus>('');
  const [search, setSearch] = useState('');

  const { data, loading, error, reload } = useAsync<Enquiry[]>(
    () => api.listEnquiries({ status: status || undefined, search: search || undefined }),
    [api, status, search]
  );

  return (
    <>
      <div className="card">
        <div className="field-row">
          <div>
            <label htmlFor="enquiry-search">{t('enquiries.searchByReference')}</label>
            <input
              id="enquiry-search" type="search" inputMode="search"
              placeholder="ENQ-2026-…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="enquiry-status">{t('enquiries.status')}</label>
            <select
              id="enquiry-status" value={status}
              onChange={(event) => setStatus(event.target.value as '' | EnquiryStatus)}
            >
              {FILTERS.map((filter) => (
                <option key={filter || 'all'} value={filter}>
                  {filter ? label('enquiryStatus', filter) : t('enquiries.all')}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? <LoadingState label={t('enquiries.loading')} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}

      {!loading && !error && data && data.length === 0 ? (
        <EmptyState
          title={t('enquiries.noMatch')}
          hint={t('enquiries.noMatchHint')}
        />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <div className="list">
          {data.map((enquiry) => (
            <Link key={enquiry.id} to={`/enquiries/${enquiry.id}`} className="row">
              <div className="title">{enquiry.reference_number}</div>
              <div className="meta">
                <span className="badge">{label('enquiryStatus', enquiry.status)}</span>{' '}
                {enquiry.assigned_to ? null : <span className="badge warn">{t('common.unassigned')}</span>}{' '}
                {enquiry.project_type ?? t('enquiries.projectTypeMissing')} · {formatDateTime(enquiry.last_action_at, language)}
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
