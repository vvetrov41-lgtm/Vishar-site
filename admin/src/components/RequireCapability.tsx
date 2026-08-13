// Route protection.
//
// This stops a person navigating to a screen their role cannot use - by typing
// the URL, or by following a stale bookmark after their role changed. It is
// still not the security boundary: the data behind every one of these screens
// is protected by row level security, so reaching the screen would show
// nothing anyway.

import type { ReactNode } from 'react';
import { useLanguage } from '../lib/i18n';
import { canAccess, type Capability } from '../lib/permissions';
import { useSession } from '../lib/session';
import { EmptyState } from './StateViews';

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { profile, memberships } = useSession();
  const { t } = useLanguage();

  if (!canAccess(profile?.role, capability, memberships)) {
    return (
      <EmptyState
        title={t('access.notAvailableTitle')}
        hint={t('access.notAvailableHint')}
      />
    );
  }

  return <>{children}</>;
}
