// Account screen: enrol, list and remove TOTP authenticators.
//
// Enrolment is two steps on purpose. A factor only counts once a code from it
// has been verified, so scanning a QR code and walking away changes nothing,
// and the database never locks an account behind an authenticator that was
// never proven to work.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { confirmDialog } from '../lib/confirm-dialog';
import { useLanguage } from '../lib/i18n';
import {
  confirmEnrollment,
  removeFactor,
  startEnrollment,
  verifiedFactors,
  type MfaEnrollment,
  type MfaFactor,
} from '../lib/mfa';
import { mfaCopy, mfaErrorMessage } from '../lib/mfa-copy';
import { useSession } from '../lib/session';

export function TwoFactorSection() {
  const { mfa, profile, refresh } = useSession();
  const { language } = useLanguage();
  const copy = mfaCopy(language);
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!mfa) return;
    try {
      setFactors(await verifiedFactors(mfa));
    } catch {
      setFactors(null);
      setError(copy.unavailable);
    }
  }, [mfa, copy.unavailable]);

  useEffect(() => { void reload(); }, [reload]);

  if (!mfa) return null;

  const enabled = (factors?.length ?? 0) > 0;

  async function begin() {
    if (!mfa) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const name = `${copy.factorName} ${(factors?.length ?? 0) + 1} · ${new Date().toISOString().slice(0, 10)}`;
      setEnrollment(await startEnrollment(mfa, name));
    } catch (cause) {
      setError(mfaErrorMessage(cause, copy));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!mfa || !enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await confirmEnrollment(mfa, enrollment.factorId, code);
      setEnrollment(null);
      setCode('');
      setNote(copy.enrolled);
      await reload();
      await refresh();
    } catch (cause) {
      setError(mfaErrorMessage(cause, copy));
    } finally {
      setBusy(false);
    }
  }

  async function remove(factor: MfaFactor) {
    if (!mfa) return;
    const confirmed = await confirmDialog({
      title: copy.remove,
      message: copy.removeConfirm,
      confirmLabel: copy.remove,
      cancelLabel: copy.cancel,
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await removeFactor(mfa, factor.id);
      setNote(copy.removed);
      await reload();
      await refresh();
    } catch (cause) {
      setError(mfaErrorMessage(cause, copy));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="account-two-factor">
      <h3 id="account-two-factor">{copy.sectionTitle}</h3>
      <p>{enabled ? copy.sectionOn : copy.sectionOff}</p>
      {!enabled && profile?.role === 'owner' ? <p className="notice warn">{copy.sectionOwnerNudge}</p> : null}

      {enabled ? (
        <ul className="two-factor-list">
          {factors?.map((factor) => (
            <li key={factor.id}>
              <span>{factor.friendly_name || copy.factorName}</span>{' '}
              <button type="button" onClick={() => { void remove(factor); }} disabled={busy}>{copy.remove}</button>
            </li>
          ))}
        </ul>
      ) : null}

      {enrollment ? (
        <form onSubmit={confirm} className="account-field">
          <p>{copy.scan}</p>
          <img src={enrollment.qrCode} alt="" width={180} height={180} />
          <small>{copy.secret} <code>{enrollment.secret}</code></small>
          <label htmlFor="two-factor-code">{copy.code}</label>
          <input
            id="two-factor-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>{busy ? copy.verifying : copy.confirm}</button>
            <button type="button" onClick={() => { setEnrollment(null); setCode(''); }} disabled={busy}>{copy.cancel}</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className={enabled ? undefined : 'primary'} onClick={() => { void begin(); }} disabled={busy || factors === null}>
            {enabled ? copy.addBackup : copy.start}
          </button>
        </div>
      )}

      {enabled && (factors?.length ?? 0) < 2 ? <small>{copy.backupHint}</small> : null}
      {note ? <p className="account-note" role="status">{note}</p> : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
    </section>
  );
}
