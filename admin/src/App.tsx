// Application root: access gate, then routing.
//
// The gate runs before any screen. An account that is signed in but has no
// active CRM profile is shown why, not a broken dashboard - and it is told the
// same thing the database would enforce anyway.

import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import './components/AppShell.css';
import { RequireCapability } from './components/RequireCapability';
import { RequireControlPlane } from './components/RequireControlPlane';
import { EmptyState, LoadingState } from './components/StateViews';
import { useLanguage } from './lib/i18n';
import { ArtistScopeProvider } from './lib/artist-scope';
import { ControlPlaneAccessProvider } from './lib/control-plane-access';
import { applyAppointmentTimeStep } from './lib/appointment-time-step';
import { ACCOUNT_PATH } from './lib/account-api';
import { matchRoute, useRouter } from './lib/router';
import { captureEvent, screenForPath } from './lib/product-analytics';
import { isPathAvailableOnSurface, useSurface } from './lib/surface';
import { useSession } from './lib/session';
import { AccountPage } from './pages/AccountPage';
import { ActivityPage } from './pages/ActivityPage';
import { ArtistOnboardingPage } from './pages/ArtistOnboardingPage';
import { ArtistSetupPage } from './pages/ArtistSetupPage';
import { AppointmentsPage } from './pages/AppointmentsPage';
import { AvailabilityPage } from './pages/AvailabilityPage';
import { BookingSourcesPage } from './pages/BookingSourcesPage';
import { CalendarConnectionsPage } from './pages/CalendarConnectionsPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { ClientMessagesPage } from './pages/ClientMessagesPage';
import { EmailThreadPage } from './pages/EmailThreadPage';
import { ConversationPage } from './pages/ConversationPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { EnquiriesPage } from './pages/EnquiriesPage';
import { EnquiryDetailPage } from './pages/EnquiryDetailPage';
import { FocusedAppointmentPage } from './pages/FocusedAppointmentPage';
import { InboxPage } from './pages/InboxPage';
import { InstagramConnectionsPage } from './pages/InstagramConnectionsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { LifecycleAutomationStudioPage } from './pages/LifecycleAutomationStudioPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LoginPage } from './pages/LoginPage';
import { OAuthConsentPage } from './pages/OAuthConsentPage';
import { PasswordSetupPage } from './pages/PasswordSetupPage';
import { SignUpPage } from './pages/SignUpPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { TelegramConnectionsPage } from './pages/TelegramConnectionsPage';
import { UsersPage } from './pages/UsersPage';
import { WhatsAppConnectionsPage } from './pages/WhatsAppConnectionsPage';
import { WorkspaceDetailPage } from './pages/WorkspaceDetailPage';
import { WorkspacesPage } from './pages/WorkspacesPage';

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
  if (state === 'signed_out') return <SignedOutRoutes />;
  if (state === 'password_setup') return <PasswordSetupPage />;
  if (state === 'verify_email') return <VerifyEmailPage />;
  if (state === 'setup') return <ArtistSetupPage />;

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
      <ControlPlaneAccessProvider>
        <AppShell>
          <Routes />
        </AppShell>
      </ControlPlaneAccessProvider>
    </ArtistScopeProvider>
  );
}

/** The only two screens a signed-out browser may reach. Everything else falls
 *  back to sign-in rather than 404ing, because a signed-out person following a
 *  deep link wants the door, not a page-not-found. */
function SignedOutRoutes() {
  const { path } = useRouter();
  if (path === '/signup') return <SignUpPage />;
  return <LoginPage />;
}

function Routes() {
  const { path } = useRouter();
  const { t } = useLanguage();
  const surface = useSurface();

  useEffect(() => {
    applyAppointmentTimeStep();
    const observer = new MutationObserver(() => applyAppointmentTimeStep());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [path]);

  // Normalized screen name only. `screenForPath` discards every dynamic
  // segment, so no enquiry, client or conversation id leaves the CRM.
  useEffect(() => {
    captureEvent('crm_screen_viewed', { screen: screenForPath(path) });
  }, [path]);

  // Checked before every route below, so a typed URL or a stale bookmark for an
  // operator-only screen says where it lives rather than rendering it. Not a
  // security boundary: the database refuses those operations to a non-owner on
  // either host, which is what actually protects them.
  if (!isPathAvailableOnSurface(path, surface)) {
    return (
      <EmptyState
        title={t('surface.internalOnlyTitle')}
        hint={t('surface.internalOnlyHint')}
      />
    );
  }

  const enquiryDetail = matchRoute('/enquiries/:id', path);
  if (enquiryDetail) {
    return (
      <RequireCapability capability="viewEnquiries">
        <EnquiryDetailPage enquiryId={enquiryDetail.id} />
      </RequireCapability>
    );
  }

  // Checked before /inbox/:id: an email thread key is a kind and an id, so it
  // has one segment more than a conversation id.
  const emailThread = matchRoute('/inbox/email/:key', path);
  if (emailThread) {
    return (
      <RequireCapability capability="viewEnquiries">
        <EmailThreadPage threadKey={emailThread.key} />
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

  const workspaceDetail = matchRoute('/workspaces/:id', path);
  if (workspaceDetail) {
    return (
      <RequireControlPlane>
        <WorkspaceDetailPage workspaceId={workspaceDetail.id} />
      </RequireControlPlane>
    );
  }

  // Artist administration, not artist work. Two audiences reach it: somebody
  // administering the organization who holds no membership on the artist, and
  // the artist themselves through their own membership - who, in a studio, has
  // no workspace membership at all. So this route is deliberately ungated in
  // the browser and authorised entirely by
  // public.artist_control_plane_context, which admits exactly those two.
  const artistDetail = matchRoute('/artists/:id', path);
  if (artistDetail) {
    return <ArtistOnboardingPage artistId={artistDetail.id} />;
  }

  const projectDetail = matchRoute('/projects/:id', path);
  if (projectDetail) {
    return (
      <RequireCapability capability="viewProjects">
        <ProjectDetailPage projectId={projectDetail.id} />
      </RequireCapability>
    );
  }

  const appointmentDetail = matchRoute('/appointments/:id', path);
  if (appointmentDetail) {
    return (
      <RequireCapability capability="viewSessions">
        <FocusedAppointmentPage appointmentId={appointmentDetail.id} />
      </RequireCapability>
    );
  }

  switch (path) {
    case '/':
      return <RequireCapability capability="viewEnquiries"><DashboardPage /></RequireCapability>;
    // Deliberately behind no capability. This is the signed-in person's own
    // account, and every operation it offers acts for auth.uid() alone; there
    // is no role that should be shown the CRM and denied its own name.
    case ACCOUNT_PATH:
      return <AccountPage />;
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
    case '/automations':
      return <RequireCapability capability="viewAutomations"><ClientMessagesPage /></RequireCapability>;
    case '/automations/advanced':
      return <RequireCapability capability="viewAutomations"><LifecycleAutomationStudioPage /></RequireCapability>;
    case '/payments':
      return <RequireCapability capability="manageFinance"><PaymentsPage /></RequireCapability>;
    case '/integrations':
      return <RequireCapability capability="manageIntegrations"><IntegrationsPage /></RequireCapability>;
    case '/integrations/forms':
      return <RequireCapability capability="manageIntegrations"><BookingSourcesPage /></RequireCapability>;
    case '/integrations/calendar':
      return <RequireCapability capability="manageIntegrations"><CalendarConnectionsPage /></RequireCapability>;
    case '/integrations/telegram':
      return <RequireCapability capability="manageIntegrations"><TelegramConnectionsPage /></RequireCapability>;
    case '/notifications':
      return <RequireCapability capability="viewNotifications"><NotificationsPage /></RequireCapability>;
    case '/integrations/whatsapp':
      return <RequireCapability capability="manageIntegrations"><WhatsAppConnectionsPage /></RequireCapability>;
    case '/integrations/instagram':
      return <RequireCapability capability="manageIntegrations"><InstagramConnectionsPage /></RequireCapability>;
    case '/workspaces':
      return <RequireControlPlane><WorkspacesPage /></RequireControlPlane>;
    case '/users':
      return <RequireCapability capability="manageUsers"><UsersPage /></RequireCapability>;
    case '/activity':
      return <RequireCapability capability="viewActivity"><ActivityPage /></RequireCapability>;
    default:
      return <EmptyState title={t('app.pageNotFound')} hint={t('app.useNavigation')} />;
  }
}