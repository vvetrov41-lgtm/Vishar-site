// Application root: access gate, then routing.
//
// The gate runs before any screen. An account that is signed in but has no
// active CRM profile is shown why, not a broken dashboard — and it is told the
// same thing the database would enforce anyway.

import { AppShell } from './components/AppShell';
import { RequireCapability } from './components/RequireCapability';
import { EmptyState, LoadingState } from './components/StateViews';
import { matchRoute, useRouter } from './lib/router';
import { useSession } from './lib/session';
import { ActivityPage } from './pages/ActivityPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { EnquiriesPage } from './pages/EnquiriesPage';
import { EnquiryDetailPage } from './pages/EnquiryDetailPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SessionsPage } from './pages/SessionsPage';
import { UsersPage } from './pages/UsersPage';

export function App() {
  const { state, signOut } = useSession();

  if (state === 'unconfigured') {
    return (
      <div className="container">
        <EmptyState
          title="The CRM is not configured"
          hint="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload. See admin/README.md."
        />
      </div>
    );
  }

  if (state === 'loading') return <LoadingState label="Checking your access…" />;
  if (state === 'signed_out') return <LoginPage />;

  if (state === 'no_profile' || state === 'deactivated') {
    return (
      <div className="container">
        <EmptyState
          title={state === 'deactivated' ? 'Your access has been withdrawn' : 'This account has no CRM access'}
          hint="Ask the owner if you think that is wrong."
        />
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button type="button" onClick={() => { void signOut(); }}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}

function Routes() {
  const { path } = useRouter();

  const enquiryDetail = matchRoute('/enquiries/:id', path);
  if (enquiryDetail) {
    return (
      <RequireCapability capability="viewEnquiries">
        <EnquiryDetailPage enquiryId={enquiryDetail.id} />
      </RequireCapability>
    );
  }

  const clientDetail = matchRoute('/clients/:id', path);
  if (clientDetail) {
    return (
      <RequireCapability capability="viewClients">
        <ClientDetailPage clientId={clientDetail.id} />
      </RequireCapability>
    );
  }

  const projectDetail = matchRoute('/projects/:id', path);
  if (projectDetail) {
    return (
      <RequireCapability capability="viewProjects">
        <ProjectDetailPage projectId={projectDetail.id} />
      </RequireCapability>
    );
  }

  switch (path) {
    case '/':
      return <RequireCapability capability="viewEnquiries"><DashboardPage /></RequireCapability>;
    case '/enquiries':
      return <RequireCapability capability="viewEnquiries"><EnquiriesPage /></RequireCapability>;
    case '/clients':
      return <RequireCapability capability="viewClients"><ClientsPage /></RequireCapability>;
    case '/projects':
      return <RequireCapability capability="viewProjects"><ProjectsPage /></RequireCapability>;
    case '/sessions':
      return <RequireCapability capability="viewSessions"><SessionsPage /></RequireCapability>;
    case '/users':
      return <RequireCapability capability="manageUsers"><UsersPage /></RequireCapability>;
    case '/activity':
      return <RequireCapability capability="viewActivity"><ActivityPage /></RequireCapability>;
    default:
      return <EmptyState title="Page not found" hint="Use the navigation below." />;
  }
}
