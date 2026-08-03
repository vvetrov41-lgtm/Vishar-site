// Application root: access gate, then routing.
//
// The gate runs before any screen. An account that is signed in but has no
// active CRM profile is shown why, not a broken dashboard — and it is told the
// same thing the database would enforce anyway.

import { AppShell } from './components/AppShell';
import { RequireCapability } from './components/RequireCapability';
import { EmptyState, LoadingState } from './components/StateViews';
import { useLanguage } from './lib/i18n';
import { ArtistScopeProvider } from './lib/artist-scope';
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
  const { t } = useLanguage();

  if (state === 'unconfigured') {
    return (
      <div className="container">
        <EmptyState
          title={t('app.notConfiguredTitle')}
          hint={t('app.notConfiguredHint')}
        />
      </div>
    );
  }

  if (state === 'loading') return <LoadingState label={t('app.checkingAccess')} />;
  if (state === 'signed_out') return <LoginPage />;

  if (state === 'no_profile' || state === 'deactivated') {
    return (
      <div className="container">
        <EmptyState
          title={state === 'deactivated' ? t('app.accessWithdrawn') : t('app.noAccess')}
          hint={t('app.askOwner')}
        />
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button type="button" onClick={() => { void signOut(); }}>{t('common.signOut')}</button>
        </div>
      </div>
    );
  }

  return (
    <ArtistScopeProvider>
      <AppShell>
        <Routes />
      </AppShell>
    </ArtistScopeProvider>
  );
}

function Routes() {
  const { path } = useRouter();
  const { t } = useLanguage();

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
      return <EmptyState title={t('app.pageNotFound')} hint={t('app.useNavigation')} />;
  }
}
