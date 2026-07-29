import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDate } from '../lib/format';
import type { Client } from '../lib/types';

export function ClientsPage() {
  const api = useApi();
  const [search, setSearch] = useState('');
  const { data, loading, error, reload } = useAsync<Client[]>(
    () => api.listClients(search || undefined),
    [api, search]
  );

  return (
    <>
      <div className="card">
        <label htmlFor="client-search">Search by name</label>
        <input
          id="client-search" type="search" inputMode="search"
          value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Client name"
        />
      </div>

      {loading ? <LoadingState label="Loading clients…" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && data && data.length === 0 ? (
        <EmptyState title="No clients match" hint="Clients are created automatically when an enquiry arrives." />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <div className="list">
          {data.map((client) => (
            <Link key={client.id} to={`/clients/${client.id}`} className="row">
              <div className="title">{client.full_name}</div>
              <div className="meta">
                {client.email ?? 'No email'} · first seen {formatDate(client.created_at)}
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
