import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { Client } from '../lib/types';

export function ClientsPage() {
  const api = useApi();
  const { t, language } = useLanguage();
  const [search, setSearch] = useState('');
  const { data, loading, error, reload } = useAsync<Client[]>(
    () => api.listClients(search || undefined),
    [api, search]
  );

  return (
    <>
      <div className="card">
        <label htmlFor="client-search">{t('clients.searchByName')}</label>
        <input
          id="client-search" type="search" inputMode="search"
          value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder={t('clients.namePlaceholder')}
        />
      </div>

      {loading ? <LoadingState label={t('clients.loading')} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && data && data.length === 0 ? (
        <EmptyState title={t('clients.noMatch')} hint={t('clients.noMatchHint')} />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <div className="list">
          {data.map((client) => (
            <Link key={client.id} to={`/clients/${client.id}`} className="row">
              <div className="title">{client.full_name}</div>
              <div className="meta">
                {client.email ?? t('clients.noEmail')} · {t('common.firstSeen', { date: formatDate(client.created_at, language) })}
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
