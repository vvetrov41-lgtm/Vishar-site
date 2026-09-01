import { useEffect, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

export function LoginPage() {
  const { signIn, error, api } = useSession();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Whether to offer the signup link at all. Asked of the server, because the
  // browser has no business deciding it and a stale build should not advertise
  // a door the database has since closed. `selfServiceSignupPolicy` already
  // fails closed, so an unreachable API leaves the link hidden.
  const [signupOpen, setSignupOpen] = useState(false);

  useEffect(() => {
    let live = true;
    if (!api) return undefined;
    void api.selfServiceSignupPolicy().then((policy) => {
      if (live) setSignupOpen(policy.is_open);
    });
    return () => { live = false; };
  }, [api]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      // The message is already on the session; nothing further to add here.
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
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{t('login.staffSignIn')}</p>

      <form className="card" onSubmit={onSubmit} noValidate>
        <label htmlFor="email">{t('login.email')}</label>
        <input
          id="email" name="email" type="email" autoComplete="username"
          value={email} onChange={(event) => setEmail(event.target.value)} required
        />

        <div style={{ height: 12 }} />

        <label htmlFor="password">{t('login.password')}</label>
        <input
          id="password" name="password" type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} required
        />

        {error ? <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p> : null}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t('login.signingIn') : t('login.signIn')}
          </button>
        </div>
      </form>

      {signupOpen ? (
        <p className="notice">
          {t('login.noAccount')} <Link to="/signup">{t('login.createAccount')}</Link>
        </p>
      ) : null}

      <p className="notice">{t('login.notice')}</p>
    </div>
  );
}
