// Which CRM this build is.
//
// One codebase, two hosts. `crm.vishartattoo.com` is the public CRM an artist
// signs up for and works in. `app.vishartattoo.com` is the internal operator
// environment, kept behind Cloudflare Access, and it is the only place the
// installation-level control plane appears.
//
// What this is and is not
// -----------------------
// This is a product boundary and a defence-in-depth layer, NOT the
// authorization boundary. Every installation-level operation is already
// refused server-side to anybody who is not the installation owner:
// `public.begin_staff_invite` and `public.set_profile_active` go through
// `crm_private.require_role('owner')`, and `public.set_self_service_signup`
// through `public.is_owner()`. A self-registered artist is a
// `booking_manager`, so the database refuses them whichever host they load the
// bundle from, and pgTAP 267 pins exactly that.
//
// What the surface adds is that the public build does not *offer* those
// screens at all - so the public CRM cannot dead-end an artist in a screen
// built for the operator, and a stolen public bundle shows no operator
// affordance to probe.
//
// Fail-closed
// -----------
// `readSurface` answers `public` for anything it does not recognise, including
// an unset variable. The consequence of guessing wrong matters in one
// direction only: an internal build mislabelled public loses the Users screen
// until the variable is set, while a public build mislabelled internal would
// offer installation administration on the open web.

import { createContext, useContext, type ReactNode } from 'react';

export type CrmSurface = 'public' | 'internal';

/**
 * Paths that exist only in the operator environment.
 *
 * Deliberately short, and deliberately not "everything that looks
 * administrative". `/workspaces` is absent because a self-service artist owns
 * their own solo organization and has to be able to open it; it is
 * tenant-scoped by `workspace_access`, not installation-level. What is here is
 * the installation's own people and roles.
 */
export const INTERNAL_ONLY_PATHS: readonly string[] = ['/users'];

export function readSurface(env: Record<string, string | undefined>): CrmSurface {
  return (env.VITE_CRM_SURFACE ?? '').trim() === 'internal' ? 'internal' : 'public';
}

export function isPathAvailableOnSurface(path: string, surface: CrmSurface): boolean {
  if (surface === 'internal') return true;
  return !INTERNAL_ONLY_PATHS.includes(path);
}

// No provider means no answer, and no answer means the restricted one.
const SurfaceContext = createContext<CrmSurface>('public');

export function SurfaceProvider({ surface, children }: { surface: CrmSurface; children: ReactNode }) {
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): CrmSurface {
  return useContext(SurfaceContext);
}
