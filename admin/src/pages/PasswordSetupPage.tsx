import { useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage, type Language } from '../lib/i18n';
import { useSession } from '../lib/session';

export function PasswordSetupPage() {
  const { completePasswordSetup } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < 12 || password.length > 128) {
      setError(copy.length);
      return;
    }
    if (password !== confirmation) {
      setError(copy.mismatch);
      return;
    }

    setBusy(true);
    try {
      await completePasswordSetup(password);
      setPassword('');
      setConfirmation('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460, paddingTop: 24 }}>
      <div className="login-language">
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>{copy.title}</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{copy.intro}</p>

      <form className="card" onSubmit={(event) => { void submit(event); }} noValidate>
        <label htmlFor="new-password">{copy.password}</label>
        <input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <div style={{ height: 12 }} />

        <label htmlFor="confirm-password">{copy.confirm}</label>
        <input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />

        <p className="notice">{copy.requirements}</p>
        {error ? <p role="alert" className="notice warn">{error}</p> : null}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? copy.saving : copy.save}
          </button>
        </div>
      </form>

      <p className="notice">{copy.next}</p>
    </div>
  );
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Set your CRM password',
    intro: 'Your secure email link has been verified. Set a new password before entering the CRM.',
    password: 'New password',
    confirm: 'Confirm new password',
    requirements: 'Use 12 to 128 characters. Production Auth may require a stronger password.',
    length: 'Choose a password between 12 and 128 characters.',
    mismatch: 'The two passwords do not match.',
    failed: 'Could not set that password.',
    save: 'Set password',
    saving: 'Saving…',
    next: 'After the password is saved, this secure session is closed. Sign in again with your email and new password.',
  },
  ru: {
    title: 'Установите пароль CRM',
    intro: 'Защищённая ссылка из письма подтверждена. Установите новый пароль перед входом в CRM.',
    password: 'Новый пароль',
    confirm: 'Повторите новый пароль',
    requirements: 'От 12 до 128 символов. Настройки production Auth могут требовать более сложный пароль.',
    length: 'Выберите пароль длиной от 12 до 128 символов.',
    mismatch: 'Пароли не совпадают.',
    failed: 'Не удалось установить пароль.',
    save: 'Установить пароль',
    saving: 'Сохранение…',
    next: 'После сохранения пароля защищённая сессия будет закрыта. Войдите снова с email и новым паролем.',
  },
};
