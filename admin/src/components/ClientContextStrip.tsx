// Client context, on a screen that is not the client.
//
// Replying to someone without knowing whether they have a booking, whether the
// deposit is settled, or what they are actually having done means opening
// another screen mid-conversation and losing your place. This puts the same
// facts the client workspace leads with onto whatever screen needs them, as one
// line, with the client's name as the way back.
//
// Supplementary by design: it never blocks the screen it sits on. A failed read
// says so quietly rather than replacing the conversation with an error.

import { useAsync } from './AsyncData';
import { can } from '../lib/permissions';
import { summariseClientWorkspace } from '../lib/client-workspace';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { typeLabel } from '../pages/AppointmentsPage';
import type { Appointment } from '../lib/appointment-api';
import type { Client, Enquiry, FollowUp, Project } from '../lib/types';

interface ContextData {
  client: Client | null;
  enquiries: Enquiry[];
  projects: Project[];
  appointments: Appointment[];
  followUps: FollowUp[];
}

export function ClientContextStrip({ clientId }: { clientId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;

  const { data, loading, error } = useAsync<ContextData>(async () => {
    const client = await api.getClient(clientId);
    if (!client) return { client: null, enquiries: [], projects: [], appointments: [], followUps: [] };

    const [enquiries, projects, appointments, followUps] = await Promise.all([
      can(role, 'viewEnquiries') ? api.listEnquiries({ clientId }) : Promise.resolve([]),
      can(role, 'viewProjects') ? api.listProjects(clientId) : Promise.resolve([]),
      can(role, 'viewSessions') ? api.listAppointments({ clientId }) : Promise.resolve([]),
      can(role, 'viewFollowUps') ? api.listFollowUps({ clientId }) : Promise.resolve([]),
    ]);

    return { client, enquiries, projects, appointments, followUps };
  }, [api, clientId, role]);

  if (loading) return <p className="meta client-context-strip" role="status">{t('common.loading')}</p>;
  if (error) return <p className="meta client-context-strip" role="status">{t('clientContext.unavailable')}</p>;
  if (!data?.client) return null;

  const snapshot = summariseClientWorkspace({
    clientId,
    enquiries: data.enquiries,
    projects: data.projects,
    appointments: data.appointments,
    followUps: data.followUps,
    conversations: [],
    now: new Date(),
  });

  const next = snapshot.nextAppointment;
  const deposit = snapshot.depositProject;
  const work = snapshot.activeProjects[0] ?? snapshot.depositProject;

  return (
    <div className="client-context-strip">
      <Link to={`/clients/${clientId}`} className="client-context-name">
        {data.client.full_name}
      </Link>
      <span className="meta client-context-facts">
        {work ? <span className="badge">{work.title}</span> : null}
        {' '}
        {next ? (
          <span className={next.status === 'confirmed' ? 'badge ok' : 'badge warn'}>
            {formatDateTime(next.start_at, language)} · {typeLabel(next.appointment_type, language)}
          </span>
        ) : (
          <span className="badge">{t('clientWorkspace.noBooking')}</span>
        )}
        {' '}
        {deposit ? (
          <span className={deposit.deposit_status === 'paid' ? 'badge ok' : 'badge warn'}>
            {t('common.deposit')}: {label('depositStatus', deposit.deposit_status)}
          </span>
        ) : null}
        {' '}
        {snapshot.overdueFollowUps.length > 0 ? (
          <span className="badge danger">
            {t('clientWorkspace.followUpsOverdue', { count: snapshot.overdueFollowUps.length })}
          </span>
        ) : null}
      </span>
    </div>
  );
}
