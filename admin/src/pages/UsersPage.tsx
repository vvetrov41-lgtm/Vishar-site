import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { ROLE_LABELS } from '../lib/permissions';
import { formatDate } from '../lib/format';
import type { CrmRole, Profile } from '../lib/types';

const ROLES: CrmRole[] = ['owner', 'booking_manager', 'read_only'];

export function UsersPage() {
  const api = useApi();
  const { profile } = useSession();
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
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading staff…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="No staff to show" />;

  return (
    <>
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <div className="list">
        {data.map((staff) => (
          <div key={staff.id} className="row">
            <div className="title">{staff.display_name ?? staff.email}</div>
            <div className="meta">
              {staff.email} · joined {formatDate(staff.created_at)}{' '}
              {staff.is_active ? <span className="badge ok">Active</span> : <span className="badge danger">Deactivated</span>}
            </div>

            <div className="actions">
              <label htmlFor={`role-${staff.id}`} className="visually-hidden">
                Role for {staff.display_name ?? staff.email}
              </label>
              <select
                id={`role-${staff.id}`}
                value={staff.role}
                disabled={busy}
                onChange={(event) => { void run(() => api.setProfileRole(staff.id, event.target.value as CrmRole)); }}
              >
                {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
              </select>

              <button
                type="button"
                className={staff.is_active ? 'danger' : ''}
                disabled={busy || staff.id === profile?.id}
                onClick={() => { void run(() => api.setProfileActive(staff.id, !staff.is_active)); }}
              >
                {staff.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="notice">
        Deactivating an account takes effect immediately at the database, even if the
        person still holds a valid session. Passwords are managed in Supabase, not
        here, and no access token is ever shown on this screen.
      </p>
    </>
  );
}
