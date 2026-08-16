import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LoadingState } from '../components/StateViews';
import type { Appointment } from '../lib/appointment-api';
import { useArtistScope } from '../lib/artist-scope';
import {
  canManageMonzoConnection,
  monzoConnectionResultNotice,
  monzoConnectorAlias,
  monzoSetupUrl,
  readMonzoConnectorOrigin,
} from '../lib/monzo-connector';
import type { DepositRequestResult, MonzoDepositSettings } from '../lib/payment-api';
import { useApi, useSession } from '../lib/session';

const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
const MONZO_CONNECTOR_ORIGIN = readMonzoConnectorOrigin(browserEnv, import.meta.env.DEV);

const EMPTY_SETTINGS: MonzoDepositSettings = {
  configured: false,
  enabled: false,
  payment_url: null,
  deposit_amount: 250,
  currency: 'GBP',
  default_delivery_channel: 'email',
  email_status: 'provider_not_connected',
  sms_status: 'not_configured',
  monzo_api_status: 'not_connected',
};

export function PaymentsPage() {
  const api = useApi();
  const { profile } = useSession();
  const { artists, selectedArtistId, loading: artistScopeLoading } = useArtistScope();
  const [settings, setSettings] = useState<MonzoDepositSettings>(EMPTY_SETTINGS);
  const [paymentUrl, setPaymentUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DepositRequestResult | null>(null);

  const selectedArtist = useMemo(
    () => artists.find((artist) => artist.id === selectedArtistId) ?? null,
    [artists, selectedArtistId]
  );
  const selectedMonzoAlias = monzoConnectorAlias(selectedArtist?.slug);
  const canManageConnection = canManageMonzoConnection(profile?.role);
  const monzoNotice = useMemo(
    () => selectedMonzoAlias
      ? monzoConnectionResultNotice(window.location.search, selectedMonzoAlias)
      : null,
    [selectedMonzoAlias]
  );

  const eligibleAppointments = useMemo(() => {
    const now = Date.now();
    return appointments.filter((appointment) =>
      appointment.appointment_type === 'tattoo_session'
      && Boolean(appointment.project_id)
      && !['completed', 'cancelled', 'no_show'].includes(appointment.status)
      && new Date(appointment.end_at).getTime() >= now
    );
  }, [appointments]);

  async function reload(artistId: string) {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextAppointments] = await Promise.all([
        api.getMonzoDepositSettings(artistId),
        api.listAppointments({ artistId, appointmentType: 'tattoo_session' }),
      ]);
      setSettings(nextSettings);
      setPaymentUrl(nextSettings.payment_url ?? '');
      setEnabled(nextSettings.enabled);
      setAppointments(nextAppointments);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load payment settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setResult(null);
    if (!selectedArtistId) {
      setSettings(EMPTY_SETTINGS);
      setPaymentUrl('');
      setEnabled(false);
      setAppointments([]);
      return;
    }
    void reload(selectedArtistId);
  }, [selectedArtistId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId) return;
    setSaving(true);
    setError(null);
    try {
      await api.configureMonzoDeposit({ artistId: selectedArtistId, paymentUrl, enabled });
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save payment settings.');
    } finally {
      setSaving(false);
    }
  }

  async function requestDeposit(sessionId: string, deliveryChannel: 'email' | 'copy_link') {
    setBusySession(sessionId);
    setError(null);
    setResult(null);
    try {
      const next = await api.requestSessionDeposit({ sessionId, deliveryChannel });
      setResult(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the deposit request.');
    } finally {
      setBusySession(null);
    }
  }

  if (artistScopeLoading) return <LoadingState label="Loading payments…" />;
  if (!selectedArtistId || !selectedArtist) {
    return <section className="panel"><div className="notice">Choose one artist to manage payments.</div></section>;
  }

  return (
    <div className="page-stack">
      {canManageConnection ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Monzo account connection</h2>
              <p>{selectedArtist.display_name}: protected bank-account connection for payment reconciliation.</p>
            </div>
          </div>

          {monzoNotice ? <div className="notice ok" role="status">{monzoNotice}</div> : null}
          {!MONZO_CONNECTOR_ORIGIN ? (
            <div className="notice">
              Monzo account connection is disabled in this environment. Existing deposit settings remain unchanged.
            </div>
          ) : selectedMonzoAlias ? (
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => window.location.assign(
                  monzoSetupUrl(MONZO_CONNECTOR_ORIGIN, selectedMonzoAlias)
                )}
              >
                Manage Monzo connection
              </button>
            </div>
          ) : (
            <div className="notice">This artist does not have a Monzo connector route.</div>
          )}
          <div className="notice">
            Connection opens as top-level navigation through the Access-protected Monzo connector. The CRM browser never receives Monzo access tokens, refresh tokens, webhook keys or bank account IDs.
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Deposits</h2>
            <p>{selectedArtist.display_name}: fixed £250 Monzo Easy Bank Transfer.</p>
          </div>
        </div>

        {loading ? <LoadingState label="Loading payment settings…" /> : (
          <form onSubmit={saveSettings} className="form-grid">
            <label className="field field-wide">
              <span>Reusable Monzo payment link</span>
              <input
                type="url"
                value={paymentUrl}
                onChange={(event) => setPaymentUrl(event.target.value)}
                placeholder="https://monzo.com/pay/r/…"
                autoComplete="off"
                required
              />
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              <span>Enable for this artist</span>
            </label>
            <div className="notice field-wide">
              Deposit amount: £250. Email: provider not connected. SMS: not configured. Monzo API: connection managed separately above.
            </div>
            <div className="field-wide">
              <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Request a deposit</h2>
            <p>The CRM creates one opaque personal path. Opening it never marks the deposit as paid.</p>
          </div>
        </div>
        {eligibleAppointments.length === 0 ? <div className="notice">No eligible future tattoo appointments.</div> : (
          <div className="list-stack">
            {eligibleAppointments.map((appointment) => (
              <div className="list-row" key={appointment.id}>
                <div>
                  <strong>{new Date(appointment.start_at).toLocaleString('en-GB')}</strong>
                  <div className="muted">{appointment.status} · {appointment.payment_status}</div>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busySession === appointment.id || !settings.enabled}
                    onClick={() => void requestDeposit(appointment.id, 'copy_link')}
                  >Create personal link</button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busySession === appointment.id || !settings.enabled}
                    onClick={() => void requestDeposit(appointment.id, 'email')}
                  >Queue £250 email</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {result ? (
        <section className="panel">
          <h2>Deposit request created</h2>
          <p><code>{result.public_path}</code></p>
          <div className="notice">
            {result.delivery_channel === 'email'
              ? 'Email is queued, but it will not send until an email provider is deliberately connected.'
              : 'The personal path is ready in CRM. A public Worker route still has to be deliberately deployed before this path can be sent to clients.'}
          </div>
        </section>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
    </div>
  );
}
