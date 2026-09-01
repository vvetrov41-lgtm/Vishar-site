// Create an account.
//
// This screen creates a Supabase Auth identity and sends a confirmation email.
// It creates nothing in the CRM - no profile, no organization, no artist. That
// happens later, on the setup screen, and only for an address that has been
// confirmed. Keeping the two apart is what makes an unconfirmed signup worth
// nothing to somebody typing in a stranger's address.
//
// The failure message is deliberately the same whatever went wrong. A form
// that says "this email is already registered" is an account oracle, and this
// one is reachable by anybody.

import { useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage, type Language } from '../lib/i18n';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from '../lib/password';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Create your account',
    intro: 'Set up your own CRM. No invitation needed.',
    email: 'Email',
    password: 'Password',
    confirm: 'Repeat password',
    requirements: `Between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters. A short phrase you will remember beats a short password.`,
    submit: 'Create account',
    working: 'Creating your account…',
    haveAccount: 'Already have an account?',
    signIn: 'Sign in',
    lengthProblem: `Choose a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    mismatchProblem: 'Those two passwords are not the same.',
    emailProblem: 'Enter your email address.',
    failed: 'That did not work. Check the address and try again, or sign in if you already have an account.',
    sentTitle: 'Check your email',
    sentBody: 'We sent a confirmation link to {email}. Open it on this device and your CRM setup continues from there.',
    sentHint: 'Nothing was created yet. The link is what confirms the address is yours.',
    backToSignIn: 'Back to sign in',
  },
  ru: {
    title: 'Создайте аккаунт',
    intro: 'Своя CRM без приглашения.',
    email: 'Email',
    password: 'Пароль',
    confirm: 'Повторите пароль',
    requirements: `От ${PASSWORD_MIN_LENGTH} до ${PASSWORD_MAX_LENGTH} символов. Длинная фраза, которую вы помните, надёжнее короткого пароля.`,
    submit: 'Создать аккаунт',
    working: 'Создаём аккаунт…',
    haveAccount: 'Уже есть аккаунт?',
    signIn: 'Войти',
    lengthProblem: `Выберите пароль от ${PASSWORD_MIN_LENGTH} до ${PASSWORD_MAX_LENGTH} символов.`,
    mismatchProblem: 'Пароли не совпадают.',
    emailProblem: 'Введите ваш email.',
    failed: 'Не получилось. Проверьте адрес и попробуйте ещё раз — или войдите, если аккаунт уже есть.',
    sentTitle: 'Проверьте почту',
    sentBody: 'Мы отправили ссылку для подтверждения на {email}. Откройте её на этом устройстве — настройка CRM продолжится там.',
    sentHint: 'Пока ничего не создано. Ссылка подтверждает, что адрес ваш.',
    backToSignIn: 'Вернуться ко входу',
  },
};

export function SignUpPage() {
  const { signUp } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const address = email.trim();
    if (!address) {
      setError(copy.emailProblem);
      return;
    }

    const problem = passwordProblem(password, confirmation);
    if (problem === 'length') {
      setError(copy.lengthProblem);
      return;
    }
    if (problem === 'mismatch') {
      setError(copy.mismatchProblem);
      return;
    }

    setBusy(true);
    try {
      const alreadySignedIn = await signUp(address, password);
      setPassword('');
      setConfirmation('');
      // When the project does not require confirmation the session already
      // exists and the access gate moves this browser on by itself. Otherwise
      // the only honest next screen is "go and read your email".
      if (!alreadySignedIn) setSentTo(address);
    } catch {
      setError(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="container" style={{ maxWidth: 460, paddingTop: 24 }}>
        <div className="login-language">
          <LanguageSwitcher />
        </div>
        <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>{copy.sentTitle}</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>{copy.sentBody.replace('{email}', sentTo)}</p>
          <p className="notice">{copy.sentHint}</p>
          <div className="actions">
            <Link to="/">{copy.backToSignIn}</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 460, paddingTop: 24 }}>
      <div className="login-language">
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>{copy.title}</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{copy.intro}</p>

      <form className="card" onSubmit={(event) => { void submit(event); }} noValidate>
        <label htmlFor="signup-email">{copy.email}</label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />

        <div style={{ height: 12 }} />

        <label htmlFor="signup-password">{copy.password}</label>
        <input
          id="signup-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <div style={{ height: 12 }} />

        <label htmlFor="signup-confirm">{copy.confirm}</label>
        <input
          id="signup-confirm"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />

        <p className="notice">{copy.requirements}</p>
        {error ? <p role="alert" className="notice warn">{error}</p> : null}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? copy.working : copy.submit}
          </button>
        </div>
      </form>

      <p className="notice">
        {copy.haveAccount} <Link to="/">{copy.signIn}</Link>
      </p>
    </div>
  );
}
