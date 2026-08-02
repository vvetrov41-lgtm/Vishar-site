import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { CrmRole, Profile } from '../lib/types';

const ROLES: CrmRole[] = ['owner', 'booking_manager', 'read_only'];

export function UsersPage() {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<Profile[]>(() => api.listProfiles(), [api]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('users.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label={t('users.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('users.noStaff')} />;

  return (
    <>
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <div className="list">
        {data.map((staff) => {
          const staffName = staff.display_name ?? staff.email;
          return (
            <div key={staff.id} className="row">
              <div className="title">{staffName}</div>
              <div className="meta">
                {staff.email} · {t('common.joined', { date: formatDate(staff.created_at, language) })}{' '}
                {staff.is_active
                  ? <span className="badge ok">{t('users.active')}</span>
                  : <span className="badge danger">{t('users.deactivated')}</span>}
              </div>

              <div className="actions">
                <label htmlFor={`role-${staff.id}`} className="visually-hidden">
                  {t('users.roleFor', { name: staffName })}
                </label>
                <select
                  id={`role-${staff.id}`}
                  value={staff.role}
                  disabled={busy}
                  onChange={(event) => { void run(() => api.setProfileRole(staff.id, event.target.value as CrmRole)); }}
                >
                  {ROLES.map((role) => <option key={role} value={role}>{label('role', role)}</option>)}
                </select>

                <button
                  type="button"
                  className={staff.is_active ? 'danger' : ''}
                  disabled={busy || staff.id === profile?.id}
                  onClick={() => { void run(() => api.setProfileActive(staff.id, !staff.is_active)); }}
                >
                  {staff.is_active ? t('users.deactivate') : t('users.reactivate')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="notice">{t('users.notice')}</p>
    </>
  );
}
