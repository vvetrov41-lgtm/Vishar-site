// Whether the signed-in profile may see the control plane, answered by the
// server.
//
// Why this exists rather than another entry in permissions.ts.
//
// That module derives everything from the legacy installation-wide `CrmRole`.
// For the older screens that is a reasonable approximation of what the database
// will allow. For the control plane it is not an approximation at all, because
// workspace authority lives in `workspace_memberships` and has no relationship
// to `CrmRole` whatsoever. Deriving it from the role got both directions wrong:
//
//   * a `read_only` profile holding genuine workspace administration was
//     refused the screen outright — a real lockout of exactly the person the
//     control plane was written for;
//   * a `booking_manager` belonging to no organization was offered a nav entry
//     that leads to an empty page.
//
// Neither is a security hole; row level security decides the data either way.
// Both are product failures, and the second kind quietly teaches people that
// the interface's affordances are noise.
//
// So the answer comes from public.control_plane_access(), which reads the same
// mirrors authorization reads. The browser still only *hides* things — the
// database remains the authority, and every screen behind this gate re-asks.

import {
  createContext, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { ControlPlaneAccess } from './control-plane-api';
import { useSession } from './session';

interface ControlPlaneAccessValue {
  access: ControlPlaneAccess | null;
  loading: boolean;
  /** True once the server has answered and said this profile belongs to at
   *  least one organization. Never inferred from a role. */
  canOpenControlPlane: boolean;
}

const ControlPlaneAccessContext = createContext<ControlPlaneAccessValue | null>(null);

export function ControlPlaneAccessProvider({ children }: { children: ReactNode }) {
  const { state, api } = useSession();
  const [access, setAccess] = useState<ControlPlaneAccess | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (state !== 'active' || !api) {
      setAccess(null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    void api.controlPlaneAccess()
      .then((result) => { if (!cancelled) setAccess(result); })
      // A failure here hides the control plane rather than guessing at it.
      // Fail closed: the screens behind it would refuse anyway.
      .catch(() => { if (!cancelled) setAccess(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [state, api]);

  const value = useMemo<ControlPlaneAccessValue>(() => ({
    access,
    loading,
    canOpenControlPlane: (access?.workspace_count ?? 0) > 0,
  }), [access, loading]);

  return (
    <ControlPlaneAccessContext.Provider value={value}>
      {children}
    </ControlPlaneAccessContext.Provider>
  );
}

export function useControlPlaneAccess(): ControlPlaneAccessValue {
  const value = useContext(ControlPlaneAccessContext);
  if (!value) {
    throw new Error('useControlPlaneAccess must be used inside a ControlPlaneAccessProvider');
  }
  return value;
}
