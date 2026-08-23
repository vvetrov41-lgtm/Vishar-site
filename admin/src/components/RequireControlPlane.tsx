// Route protection for the control plane, gated on the server's answer.
//
// The sibling RequireCapability derives its decision from the legacy CrmRole,
// which is meaningless for workspace authority. This one waits for
// public.control_plane_access() and gates on that. Like its sibling it is not
// the security boundary: every screen behind it re-asks the database, and row
// level security decides the data regardless of what renders.

import type { ReactNode } from 'react';
import { useControlPlaneAccess } from '../lib/control-plane-access';
import { useLanguage } from '../lib/i18n';
import { EmptyState, LoadingState } from './StateViews';

export function RequireControlPlane({ children }: { children: ReactNode }) {
  const { canOpenControlPlane, loading } = useControlPlaneAccess();
  const { t } = useLanguage();

  // Deliberately not rendered as "no access" while the answer is in flight:
  // showing a refusal and then replacing it with the screen is worse than a
  // moment of loading.
  if (loading) return <LoadingState />;

  if (!canOpenControlPlane) {
    return (
      <EmptyState
        title={t('access.controlPlaneTitle')}
        hint={t('access.controlPlaneHint')}
      />
    );
  }

  return <>{children}</>;
}
