import { useEffect, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage } from '../lib/i18n';
import { requestPasswordRecovery } from '../lib/password-recovery';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

type LoginMode = 'sign_in' | 'forgot_password' | 'recovery_sent';

export function LoginPage() {
  const { signIn, error, api } = useSession();
  const { t, language } = useLanguage();
  const recoveryCopy = language === 'ru' ? RECOVERY_COPY.ru : RECOVERY_COPY.en;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<LoginMode>('sign_in');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
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

  async function onPasswordRecovery(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRecoveryError(null);
    try {
      await requestPasswordRecovery(email.trim());
      setMode('recovery_sent');
    } catch {
      // Deliberately generic. Neither success nor failure should tell a visitor
      // whether this address belongs to a CRM account.
      setRecoveryError(recoveryCopy.failed);
    } finally {
      setBusy(false);
    }
  }

  function backToSignIn() {
    setMode('sign_in');
    setRecoveryError(null);
  }

  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 24 }}>
      <div className="login-language">
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>Vishar CRM</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        {mode === 'sign_in' ? t('login.staffSignIn') : recoveryCopy.subtitle}
      </p>

      {mode === 'sign_in' ? (
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

          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button
              type="button"
              onClick={() => { setMode('forgot_password'); setRecoveryError(null); }}
              style={LINK_BUTTON_STYLE}
            >
              {recoveryCopy.forgot}
            </button>
          </div>

          {error ? <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p> : null}

          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? t('login.signingIn') : t('login.signIn')}
            </button>
          </div>
        </form>
      ) : mode === 'forgot_password' ? (
        <form className="card" onSubmit={onPasswordRecovery} noValidate>
          <p style={{ marginTop: 0 }}>{recoveryCopy.instructions}</p>
          <label htmlFor="recovery-email">{t('login.email')}</label>
          <input
            id="recovery-email"
            name="recovery-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          {recoveryError ? (
            <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{recoveryError}</p>
          ) : null}

          <div className="actions">
            <button type="button" onClick={backToSignIn}>{recoveryCopy.back}</button>
            <button className="primary" type="submit" disabled={busy || !email.trim()}>
              {busy ? recoveryCopy.sending : recoveryCopy.send}
            </button>
          </div>
        </form>
      ) : (
        <div className="card">
          <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>{recoveryCopy.checkEmail}</h2>
          <p>{recoveryCopy.sent}</p>
          <div className="actions">
            <button className="primary" type="button" onClick={backToSignIn}>
              {recoveryCopy.back}
            </button>
          </div>
        </div>
      )}

      {mode === 'sign_in' && signupOpen ? (
        <p className="notice">
          {t('login.noAccount')} <Link to="/signup">{t('login.createAccount')}</Link>
        </p>
      ) : null}
    </div>
  );
}

const LINK_BUTTON_STYLE = {
  appearance: 'none',
  background: 'none',
  border: 0,
  color: 'var(--accent)',
  cursor: 'pointer',
  font: 'inherit',
  padding: 0,
  textDecoration: 'underline',
} as const;

const RECOVERY_COPY = {
  en: {
    forgot: 'Forgot password?',
    subtitle: 'Recover access to Vishar CRM',
    instructions: 'Enter the email you use for the CRM. If an account exists, we will send a secure password reset link.',
    send: 'Send reset link',
    sending: 'Sending…',
    back: 'Back to sign in',
    failed: 'Could not send the reset email just now. Wait a minute and try again.',
    checkEmail: 'Check your email',
    sent: 'If an account exists for that email, a password reset link has been sent. Open the link to set a new password.',
  },
  ru: {
    forgot: 'Забыли пароль?',
    subtitle: 'Восстановление доступа к Vishar CRM',
    instructions: 'Введите email, который вы используете для CRM. Если аккаунт существует, мы отправим защищённую ссылку для смены пароля.',
    send: 'Отправить ссылку',
    sending: 'Отправка…',
    back: 'Вернуться ко входу',
    failed: 'Сейчас не удалось отправить письмо. Подождите минуту и попробуйте снова.',
    checkEmail: 'Проверьте почту',
    sent: 'Если аккаунт с таким email существует, ссылка для смены пароля уже отправлена. Откройте её и установите новый пароль.',
  },
} as const;
