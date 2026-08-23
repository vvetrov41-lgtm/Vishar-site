// Editing what one person may do on one artist.
//
// The design problem, and why this is not a checkbox list of capabilities.
//
// The database accepts exactly five things: an access level and four booleans.
// Everything else — "may they move an appointment", "may they see the money" —
// is *derived* from those five by crm_private.capability_from_grant. A screen
// that offered capabilities directly would be offering something the database
// has no way to store, and would have to invent a mapping to get back to the
// five. That mapping is a second permission model, and it drifts.
//
// So this edits the grant, and *reads back* the consequences from the server
// through preview_membership_capabilities, which asks the same function the
// real authorization check asks. The capability list below is therefore never
// a promise this component makes. It is a report of what the database says it
// would do, refreshed whenever the grant changes.
//
// The practical payoff shows up with a read_only profile: every box can be
// ticked and every write capability still comes back withheld, because the
// legacy global role narrows what any membership can mean. A browser-side copy
// of the rules would have shown those rights as granted and then failed on
// save.

import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import type {
  CapabilityPreviewRow,
  MembershipGrant,
} from '../lib/control-plane-api';
import type { ArtistAccessLevel } from '../lib/types';

const ASSIGNABLE_LEVELS: Exclude<ArtistAccessLevel, 'owner'>[] = ['artist', 'manager', 'read_only'];

const DOMAIN_ORDER = [
  'clients', 'enquiries', 'projects', 'sessions', 'finance',
  'communications', 'integrations', 'booking', 'notifications',
  'automations', 'team',
];

function domainLabel(domain: string, ru: boolean): string {
  const en: Record<string, string> = {
    clients: 'Clients', enquiries: 'Enquiries', projects: 'Projects',
    sessions: 'Appointments', finance: 'Money', communications: 'Messages',
    integrations: 'Integrations', booking: 'Booking forms',
    notifications: 'Notifications', automations: 'Automations', team: 'Team',
  };
  const rus: Record<string, string> = {
    clients: 'Клиенты', enquiries: 'Заявки', projects: 'Проекты',
    sessions: 'Записи', finance: 'Финансы', communications: 'Сообщения',
    integrations: 'Интеграции', booking: 'Формы записи',
    notifications: 'Уведомления', automations: 'Автоматизации', team: 'Команда',
  };
  return (ru ? rus[domain] : en[domain]) ?? domain;
}

export function CapabilityEditor({
  value,
  onChange,
  preview,
  previewLoading,
  disabled = false,
  showActive = true,
}: {
  value: MembershipGrant;
  onChange: (next: MembershipGrant) => void;
  preview: CapabilityPreviewRow[] | null;
  previewLoading: boolean;
  disabled?: boolean;
  showActive?: boolean;
}) {
  const { language } = useLanguage();
  const ru = language === 'ru';
  const [showAll, setShowAll] = useState(false);

  // Managing money is meaningless without being able to see it, and the
  // database would refuse the pair anyway. Keep the two in step here so the
  // person is never looking at a state that cannot be saved.
  function update(patch: Partial<MembershipGrant>) {
    const next = { ...value, ...patch };
    if (next.accessLevel === 'read_only') {
      next.canViewFinance = false;
      next.canManageFinance = false;
      next.canManageSessions = false;
      next.canManageIntegrations = false;
    }
    // Order matters here, and getting it wrong makes "Manage money"
    // unclickable: applying the "no manage without view" rule first undoes the
    // tick before the "manage implies view" rule can turn view on. So branch on
    // what the person actually just did rather than on the merged state.
    if (patch.canManageFinance === true) {
      next.canViewFinance = true;
    } else if (!next.canViewFinance) {
      next.canManageFinance = false;
    }
    onChange(next);
  }

  const grouped = useMemo(() => {
    if (!preview) return [];
    const byDomain = new Map<string, CapabilityPreviewRow[]>();
    for (const row of preview) {
      const list = byDomain.get(row.domain) ?? [];
      list.push(row);
      byDomain.set(row.domain, list);
    }
    return [...byDomain.entries()].sort(
      (a, b) => DOMAIN_ORDER.indexOf(a[0]) - DOMAIN_ORDER.indexOf(b[0]),
    );
  }, [preview]);

  const grantedCount = preview?.filter((row) => row.granted).length ?? 0;

  return (
    <div className="capability-editor">
      <div className="cap-grants">
        {showActive ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.isActive}
              disabled={disabled}
              onChange={(event) => update({ isActive: event.target.checked })}
            />
            <span>{ru ? 'Доступ активен' : 'Access is active'}</span>
          </label>
        ) : null}

        <label className="cap-field">
          <span>{ru ? 'Уровень' : 'Level'}</span>
          <select
            value={value.accessLevel === 'owner' ? 'artist' : value.accessLevel}
            disabled={disabled || !value.isActive}
            onChange={(event) => update({
              accessLevel: event.target.value as ArtistAccessLevel,
            })}
          >
            {ASSIGNABLE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === 'artist' ? (ru ? 'Мастер' : 'Artist')
                  : level === 'manager' ? (ru ? 'Менеджер' : 'Manager')
                  : (ru ? 'Только чтение' : 'Read only')}
              </option>
            ))}
          </select>
        </label>

        <fieldset
          className="cap-flags"
          disabled={disabled || !value.isActive || value.accessLevel === 'read_only'}
        >
          <legend>{ru ? 'Дополнительно' : 'Also allow'}</legend>
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.canManageSessions}
              onChange={(event) => update({ canManageSessions: event.target.checked })}
            />
            <span>{ru ? 'Управлять записями' : 'Manage appointments'}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.canViewFinance}
              onChange={(event) => update({ canViewFinance: event.target.checked })}
            />
            <span>{ru ? 'Видеть финансы' : 'See money'}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.canManageFinance}
              onChange={(event) => update({ canManageFinance: event.target.checked })}
            />
            <span>{ru ? 'Управлять финансами' : 'Manage money'}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.canManageIntegrations}
              onChange={(event) => update({ canManageIntegrations: event.target.checked })}
            />
            <span>{ru ? 'Управлять интеграциями и формами' : 'Manage integrations and forms'}</span>
          </label>
        </fieldset>

        <p className="meta">
          {ru
            ? 'Финансы и интеграции нельзя выдать, если у вас самих их нет на этом мастере. База данных откажет.'
            : 'You cannot grant money or integration access you do not hold on this artist yourself. The database will refuse.'}
        </p>
      </div>

      <div className="cap-preview">
        <div className="cap-preview-head">
          <strong>
            {ru ? 'Что это разрешает' : 'What this allows'}
            {preview ? ` · ${grantedCount}` : ''}
          </strong>
          <button
            type="button"
            className="linklike"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll
              ? (ru ? 'Только разрешённое' : 'Only what is allowed')
              : (ru ? 'Показать всё' : 'Show everything')}
          </button>
        </div>

        {previewLoading ? (
          <p className="meta" role="status">{ru ? 'Считаем…' : 'Working it out…'}</p>
        ) : !preview ? (
          <p className="meta">{ru ? 'Недоступно.' : 'Not available.'}</p>
        ) : (
          <div className="cap-domains">
            {grouped.map(([domain, rows]) => {
              const visible = showAll ? rows : rows.filter((row) => row.granted);
              if (visible.length === 0) return null;
              return (
                <div key={domain} className="cap-domain">
                  <h4>{domainLabel(domain, ru)}</h4>
                  <ul>
                    {visible.map((row) => (
                      <li
                        key={row.capability}
                        className={row.granted ? 'cap-yes' : 'cap-no'}
                        title={row.description}
                      >
                        <span aria-hidden="true">{row.granted ? '✓' : '·'}</span>
                        <span>{row.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        <p className="meta">
          {ru
            ? 'Список приходит с сервера той же функцией, которая решает доступ на самом деле.'
            : 'This list comes from the server, from the same function that decides access for real.'}
        </p>
      </div>
    </div>
  );
}

/** Debounced capability preview. The grant changes on every keystroke-free
 *  click, and each change is a round trip, so this coalesces them. */
export function useCapabilityPreview(
  loader: (grant: Omit<MembershipGrant, 'isActive'>) => Promise<CapabilityPreviewRow[]>,
  grant: MembershipGrant,
  enabled: boolean,
) {
  const [preview, setPreview] = useState<CapabilityPreviewRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const key = [
    grant.accessLevel, grant.canViewFinance, grant.canManageFinance,
    grant.canManageSessions, grant.canManageIntegrations,
  ].join('|');

  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      loader({
        accessLevel: grant.accessLevel,
        canViewFinance: grant.canViewFinance,
        canManageFinance: grant.canManageFinance,
        canManageSessions: grant.canManageSessions,
        canManageIntegrations: grant.canManageIntegrations,
      })
        .then((rows) => { if (!cancelled) setPreview(rows); })
        // A refusal here is not an error worth shouting about: it means the
        // reader may not ask, which the save would refuse anyway.
        .catch(() => { if (!cancelled) setPreview(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);

    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { preview, loading };
}
