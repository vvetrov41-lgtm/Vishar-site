import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { ENQUIRY_STATUS_LABELS } from '../lib/permissions';
import { formatDateTime } from '../lib/format';
import type { Enquiry, EnquiryStatus } from '../lib/types';

const FILTERS: { value: '' | EnquiryStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'waiting_for_client', label: 'Waiting for client' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'quote_sent', label: 'Quote sent' },
  { value: 'deposit_requested', label: 'Deposit requested' },
  { value: 'deposit_paid', label: 'Deposit paid' },
  { value: 'converted', label: 'Converted' },
  { value: 'declined', label: 'Declined' },
  { value: 'closed', label: 'Closed' },
];

export function EnquiriesPage() {
  const api = useApi();
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
            <label htmlFor="enquiry-search">Search by reference</label>
            <input
              id="enquiry-search" type="search" inputMode="search"
              placeholder="ENQ-2026-…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="enquiry-status">Status</label>
            <select
              id="enquiry-status" value={status}
              onChange={(event) => setStatus(event.target.value as '' | EnquiryStatus)}
            >
              {FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? <LoadingState label="Loading enquiries…" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}

      {!loading && !error && data && data.length === 0 ? (
        <EmptyState
          title="No enquiries match"
          hint="Only enquiries whose images finished uploading appear here."
        />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <div className="list">
          {data.map((enquiry) => (
            <Link key={enquiry.id} to={`/enquiries/${enquiry.id}`} className="row">
              <div className="title">{enquiry.reference_number}</div>
              <div className="meta">
                <span className="badge">{ENQUIRY_STATUS_LABELS[enquiry.status]}</span>{' '}
                {enquiry.assigned_to ? null : <span className="badge warn">Unassigned</span>}{' '}
                {enquiry.project_type ?? 'Project type not given'} · {formatDateTime(enquiry.last_action_at)}
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
