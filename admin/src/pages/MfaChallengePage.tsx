// The second step of signing in, for an account with a verified factor.

import { useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage } from '../lib/i18n';
import { mfaCopy, mfaErrorMessage } from '../lib/mfa-copy';
import { useSession } from '../lib/session';

export function MfaChallengePage() {
  const { verifyMfa, signOut } = useSession();
  const { language } = useLanguage();
  const copy = mfaCopy(language);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(code);
    } catch (cause) {
      setError(mfaErrorMessage(cause, copy));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 24 }}>
      <div className="login-language">
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>Vishar CRM</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{copy.challengeTitle}</p>
      <form className="card" onSubmit={onSubmit} noValidate>
        <p style={{ marginTop: 0 }}>{copy.challengeHint}</p>
        <label htmlFor="mfa-code">{copy.code}</label>
        <input
          id="mfa-code"
          name="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={8}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        {error ? <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p> : null}
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? copy.verifying : copy.verify}
          </button>
          <button type="button" onClick={() => { void signOut(); }}>{copy.signOut}</button>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 0 }}>{copy.lostDevice}</p>
      </form>
    </div>
  );
}
