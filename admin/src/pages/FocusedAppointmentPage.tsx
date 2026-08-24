import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { can } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { useLanguage } from '../lib/i18n';
import type { Client, Enquiry, Project, SessionStatus } from '../lib/types';
import type { Appointment } from '../lib/appointment-api';
import { AppointmentRow } from './AppointmentsPage';

type PageData = {
  appointments: Appointment[];
  projects: Project[];
  enquiries: Enquiry[];
  clients: Client[];
};

export function FocusedAppointmentPage({ appointmentId }: { appointmentId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { language, label } = useLanguage();
  const mayManage = can(profile?.role, 'manageSessions');
  const [changing, setChanging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A notification may belong to another Artist than the currently selected
  // usability scope. Load the caller's full RLS-authorised appointment surface,
  // then render only the exact session encoded by the notification entity id.
  const state = useAsync<PageData>(async () => {
    const [appointments, projects, enquiries, clients] = await Promise.all([
      api.listAppointments({}),
      api.listProjects(),
      api.listEnquiries({}),
      api.listClients(),
    ]);
    return { appointments, projects, enquiries, clients };
  }, [api, appointmentId]);

  if (state.loading) {
    return <LoadingState label={language === 'ru' ? 'Загрузка записи…' : 'Loading appointment…'} />;
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const data = state.data;
  const appointment = data?.appointments.find((item) => item.id === appointmentId) ?? null;

  async function changeStatus(status: SessionStatus) {
    if (!appointment) return;
    setChanging(true);
    setActionError(null);
    try {
      await api.setAppointmentStatus(appointment.id, status);
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (language === 'ru' ? 'Не удалось изменить запись.' : 'Could not change that appointment.'));
    } finally {
      setChanging(false);
    }
  }

  async function reschedule(startAt: string, endAt: string) {
    if (!appointment) return;
    setChanging(true);
    setActionError(null);
    try {
      await api.rescheduleAppointment({ appointmentId: appointment.id, startAt, endAt });
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (language === 'ru' ? 'Не удалось перенести запись.' : 'Could not reschedule that appointment.'));
      throw cause;
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="stack">
      <Section title={language === 'ru' ? 'Запись из уведомления' : 'Appointment from notification'}>
        <div className="actions">
          <Link to="/appointments">{language === 'ru' ? 'Все записи' : 'All appointments'}</Link>
        </div>
      </Section>

      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}

      {!data || !appointment ? (
        <EmptyState
          title={language === 'ru' ? 'Запись недоступна' : 'Appointment unavailable'}
          hint={language === 'ru'
            ? 'Она могла быть удалена или у вашего аккаунта больше нет доступа к этому мастеру.'
            : 'It may have been removed or your account may no longer have access to that Artist.'}
        />
      ) : (
        <div className="list" data-focused-appointment-id={appointment.id}>
          <AppointmentRow
            appointment={appointment}
            client={data.clients.find((client) => client.id === appointment.client_id) ?? null}
            enquiry={data.enquiries.find((enquiry) => enquiry.id === appointment.enquiry_id) ?? null}
            project={data.projects.find((project) => project.id === appointment.project_id) ?? null}
            language={language}
            statusLabel={label('sessionStatus', appointment.status)}
            paymentLabel={label('paymentStatus', appointment.payment_status)}
            mayManage={mayManage}
            changing={changing}
            onStatus={(status) => { void changeStatus(status); }}
            onReschedule={reschedule}
          />
        </div>
      )}
    </div>
  );
}
