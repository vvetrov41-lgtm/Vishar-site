// Application root: access gate, then routing.
//
// The gate runs before any screen. An account that is signed in but has no
// active CRM profile is shown why, not a broken dashboard - and it is told the
// same thing the database would enforce anyway.

import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import './components/AppShell.css';
import { RequireCapability } from './components/RequireCapability';
import { EmptyState, LoadingState } from './components/StateViews';
import { useLanguage } from './lib/i18n';
import { ArtistScopeProvider } from './lib/artist-scope';
import { applyAppointmentTimeStep } from './lib/appointment-time-step';
import { matchRoute, useRouter } from './lib/router';
import { useSession } from './lib/session';
import { ActivityPage } from './pages/ActivityPage';
import { AppointmentsPage } from './pages/AppointmentsPage';
import { AvailabilityPage } from './pages/AvailabilityPage';
import { BookingSourcesPage } from './pages/BookingSourcesPage';
import { CalendarConnectionsPage } from './pages/CalendarConnectionsPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { ConversationPage } from './pages/ConversationPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { EnquiriesPage } from './pages/EnquiriesPage';
import { EnquiryDetailPage } from './pages/EnquiryDetailPage';
import { InboxPage } from './pages/InboxPage';
import { InstagramConnectionsPage } from './pages/InstagramConnectionsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LoginPage } from './pages/LoginPage';
import { OAuthConsentPage } from './pages/OAuthConsentPage';
import { PasswordSetupPage } from './pages/PasswordSetupPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { UsersPage } from './pages/UsersPage';
import { WhatsAppConnectionsPage } from './pages/WhatsAppConnectionsPage';

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
  if (state === 'password_setup') return <PasswordSetupPage />;

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

  useEffect(() => {
    applyAppointmentTimeStep();
    const observer = new MutationObserver(() => applyAppointmentTimeStep());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [path]);

  const enquiryDetail = matchRoute('/enquiries/:id', path);
  if (enquiryDetail) {
    return (
      <RequireCapability capability="viewEnquiries">
        <EnquiryDetailPage enquiryId={enquiryDetail.id} />
      </RequireCapability>
    );
  }

  const conversationDetail = matchRoute('/inbox/:id', path);
  if (conversationDetail) {
    return (
      <RequireCapability capability="viewEnquiries">
        <ConversationPage conversationId={conversationDetail.id} />
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
    case '/oauth/consent':
      return <OAuthConsentPage />;
    case '/inbox':
      return <RequireCapability capability="viewEnquiries"><InboxPage /></RequireCapability>;
    case '/enquiries':
      return <RequireCapability capability="viewEnquiries"><EnquiriesPage /></RequireCapability>;
    case '/clients':
      return <RequireCapability capability="viewClients"><ClientsPage /></RequireCapability>;
    case '/projects':
      return <RequireCapability capability="viewProjects"><ProjectsPage /></RequireCapability>;
    case '/appointments':
    case '/sessions':
      return <RequireCapability capability="viewSessions"><AppointmentsPage /></RequireCapability>;
    case '/availability':
      return <RequireCapability capability="viewSessions"><AvailabilityPage /></RequireCapability>;
    case '/payments':
      return <RequireCapability capability="manageFinance"><PaymentsPage /></RequireCapability>;
    case '/integrations':
      return <RequireCapability capability="manageIntegrations"><IntegrationsPage /></RequireCapability>;
    case '/integrations/forms':
      return <RequireCapability capability="manageIntegrations"><BookingSourcesPage /></RequireCapability>;
    case '/integrations/calendar':
      return <RequireCapability capability="manageIntegrations"><CalendarConnectionsPage /></RequireCapability>;
    case '/notifications':
      return <RequireCapability capability="viewNotifications"><NotificationsPage /></RequireCapability>;
    case '/integrations/whatsapp':
      return <RequireCapability capability="manageIntegrations"><WhatsAppConnectionsPage /></RequireCapability>;
    case '/integrations/instagram':
      return <RequireCapability capability="manageIntegrations"><InstagramConnectionsPage /></RequireCapability>;
    case '/users':
      return <RequireCapability capability="manageUsers"><UsersPage /></RequireCapability>;
    case '/activity':
      return <RequireCapability capability="viewActivity"><ActivityPage /></RequireCapability>;
    default:
      return <EmptyState title={t('app.pageNotFound')} hint={t('app.useNavigation')} />;
  }
}
