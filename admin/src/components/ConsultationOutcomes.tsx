import { useState } from 'react';
import { useAsync } from './AsyncData';
import { Section } from './StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { Client } from '../lib/types';

/**
 * Ended consultations whose outcome is not known yet. A past date does not
 * prove the client came, so Statistics counts none of these as held until the
 * operator answers here, or a later tattoo booking answers on the server.
 */
export function ConsultationOutcomes({
  artistId,
  mayManage,
  onChanged,
}: {
  artistId: string | null;
  mayManage: boolean;
  onChanged?: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync<{ rows: Appointment[]; clients: Client[] }>(async () => {
    if (!mayManage) return { rows: [], clients: [] };
    const rows = await api.listConsultationsAwaitingOutcome({ artistId: artistId ?? undefined });
    const clients = rows.length > 0 ? await api.listClientsByIds(rows.map((row) => row.client_id)) : [];
    return { rows, clients };
  }, [api, artistId, mayManage]);

  // Most recent first, so the one just finished is at the top.
  const rows = [...(state.data?.rows ?? [])].sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  if (!mayManage || rows.length === 0) return null;

  async function record(appointment: Appointment, status: 'completed' | 'no_show') {
    setBusyId(appointment.id);
    setError(null);
    try {
      await api.setAppointmentStatus(appointment.id, status);
      state.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div id="consultation-outcomes">
      <Section title={copy.title}>
        <p className="meta">{copy.hint}</p>
        {error ? <p className="notice warn" role="alert">{error}</p> : null}
        <div className="list">
          {rows.map((appointment) => {
            const client = state.data?.clients.find((entry) => entry.id === appointment.client_id);
            const name = `${client?.full_name ?? copy.client} · ${formatDateTime(appointment.start_at, language)}`;
            return (
              <div key={appointment.id} className="row">
                <div className="title">{name}</div>
                <div className="actions">
                  <button type="button" disabled={busyId !== null} aria-label={`${copy.held}: ${name}`}
                    onClick={() => { void record(appointment, 'completed'); }}>{copy.held}</button>
                  <button type="button" disabled={busyId !== null} aria-label={`${copy.noShow}: ${name}`}
                    onClick={() => { void record(appointment, 'no_show'); }}>{copy.noShow}</button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Consultations: did they take place?',
    hint: 'These consultations have ended. Until you answer, Statistics does not count them as held. A tattoo booked for the client afterwards answers for you.',
    held: 'Took place',
    noShow: 'Client did not come',
    client: 'Client',
    failed: 'Could not save the outcome.',
  },
  ru: {
    title: 'Консультации: состоялись?',
    hint: 'Эти консультации уже прошли. Пока ты не ответишь, Statistics не считает их состоявшимися. Если клиент после консультации забронировал тату, ответ ставится сам.',
    held: 'Состоялась',
    noShow: 'Клиент не пришёл',
    client: 'Клиент',
    failed: 'Не удалось сохранить результат.',
  },
};
