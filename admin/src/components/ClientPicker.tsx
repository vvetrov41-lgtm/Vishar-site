// Choosing a client, at any number of clients.
//
// Booking used to offer a native `<select>` over the 200 most recently created
// clients. On a phone that is a wheel picker with 200 entries and no search; on
// any device it silently cannot offer the 201st client at all. And it asked the
// operator to recognise a name in a list rather than type the thing they
// actually have in front of them - a phone number, an Instagram handle, an
// email.
//
// Search goes to the same query the Clients screen uses, which matches name,
// email, phone and Instagram. The chosen client stays named on screen so the
// operator can see who they are booking without reopening anything.

import { useEffect, useState } from 'react';
import { useAsync } from './AsyncData';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { formatPhoneForDisplay } from '../lib/phone';
import { useApi } from '../lib/session';
import type { Language } from '../lib/i18n';
import type { Client } from '../lib/types';

const COPY = {
  en: {
    search: 'Find the client',
    searchHint: 'Search by name, phone, email or Instagram.',
    searching: 'Searching…',
    noMatches: 'No clients match that',
    change: 'Choose someone else',
    chosen: 'Client',
    resolving: 'Loading client…',
    unknown: 'Client not available',
  },
  ru: {
    search: 'Найти клиента',
    searchHint: 'Поиск по имени, телефону, email или Instagram.',
    searching: 'Ищем…',
    noMatches: 'Совпадений нет',
    change: 'Выбрать другого',
    chosen: 'Клиент',
    resolving: 'Загружаем клиента…',
    unknown: 'Клиент недоступен',
  },
} as const;

export function ClientPicker({
  value,
  onChange,
  language,
  disabled = false,
  inputId = 'client-picker-search',
}: {
  value: string;
  onChange: (clientId: string) => void;
  language: Language;
  /** True when the client is implied by a chosen project or enquiry. */
  disabled?: boolean;
  inputId?: string;
}) {
  const api = useApi();
  const copy = COPY[language];
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());

  // The selected id can arrive from a project or enquiry rather than from this
  // control, so the name is resolved from the id rather than remembered.
  const { data: selected, loading: resolving } = useAsync<Client | null>(
    () => (value ? api.getClient(value) : Promise.resolve(null)),
    [api, value],
  );

  const { data: matches, loading: searching } = useAsync<Client[]>(
    () => (debounced ? api.listClients(debounced) : Promise.resolve([])),
    [api, debounced],
  );

  useEffect(() => {
    if (value) setSearch('');
  }, [value]);

  if (value) {
    return (
      <div className="client-picker">
        <span className="client-picker-label">{copy.chosen}</span>
        <span className="client-picker-chosen">
          {resolving ? copy.resolving : selected?.full_name ?? copy.unknown}
        </span>
        {disabled ? null : (
          <button type="button" className="client-picker-change" onClick={() => onChange('')}>
            {copy.change}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="client-picker">
      <label htmlFor={inputId}>{copy.search}</label>
      <input
        id={inputId}
        type="search"
        autoComplete="off"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="meta">{copy.searchHint}</p>
      {searching && debounced ? <p className="meta">{copy.searching}</p> : null}
      {!searching && debounced && (matches ?? []).length === 0 ? (
        <p className="notice">{copy.noMatches}</p>
      ) : null}
      {(matches ?? []).length > 0 ? (
        <div className="list client-picker-results">
          {(matches ?? []).slice(0, 12).map((client) => (
            <button
              key={client.id}
              type="button"
              className="row client-picker-result"
              onClick={() => onChange(client.id)}
            >
              <span className="title">{client.full_name}</span>
              <span className="meta">
                {[formatPhoneForDisplay(client.phone), client.email, client.instagram]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
