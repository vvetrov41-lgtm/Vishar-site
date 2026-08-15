import { useState } from 'react';
import { ArtistRelationship } from '../components/ArtistRelationship';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { collectClientArtistIds } from '../lib/client-artist-relationships';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import type { Client } from '../lib/types';
import { useDebouncedValue } from '../lib/use-debounced-value';

export function ClientsPage() {
  const api = useApi();
  const { t, language } = useLanguage();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim());
  const { data, loading, error, reload } = useAsync<Client[]>(
    () => api.listClients(debouncedSearch || undefined),
    [api, debouncedSearch]
  );
  const {
    data: clientArtistIds,
    error: relationshipError,
    reload: reloadRelationships,
  } = useAsync<Map<string, string[]>>(async () => {
    const [enquiries, projects] = await Promise.all([
      api.listEnquiries(),
      api.listProjects(),
    ]);
    return collectClientArtistIds(enquiries, projects);
  }, [api]);

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
      {relationshipError ? (
        <ErrorState message={relationshipError} onRetry={reloadRelationships} />
      ) : null}
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
              {clientArtistIds ? (
                <div className="meta">
                  <ArtistRelationship
                    artistIds={clientArtistIds.get(client.id) ?? []}
                    showEmpty
                  />
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
