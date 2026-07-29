// Route protection.
//
// This stops a person navigating to a screen their role cannot use — by typing
// the URL, or by following a stale bookmark after their role changed. It is
// still not the security boundary: the data behind every one of these screens
// is protected by row level security, so reaching the screen would show
// nothing anyway.

import type { ReactNode } from 'react';
import { can, type Capability } from '../lib/permissions';
import { useSession } from '../lib/session';
import { EmptyState } from './StateViews';

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { profile } = useSession();

  if (!can(profile?.role, capability)) {
    return (
      <EmptyState
        title="Not available for your role"
        hint="If you need this, ask the owner to change your access."
      />
    );
  }

  return <>{children}</>;
}
