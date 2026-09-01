// Signed in, address not confirmed yet.
//
// A real state, not a courtesy screen. public.bootstrap_artist_account refuses
// an unconfirmed address, so this browser genuinely cannot proceed - and being
// told that, with the address it is waiting on and a way to send the link
// again, is better than a setup form that fails on submit.

import { useState } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage, type Language } from '../lib/i18n';
import { useSession } from '../lib/session';

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Confirm your email',
    body: 'We sent a link to {email}. Open it and this page continues by itself.',
    noAddress: 'We sent you a confirmation link. Open it and this page continues by itself.',
    hint: 'Links expire. If yours has, send another one — the old one stops working.',
    resend: 'Send another link',
    sending: 'Sending…',
    sent: 'Sent. Check your inbox, and your spam folder.',
    failed: 'Could not send another email just now. Wait a minute and try again.',
    signOut: 'Sign out',
  },
  ru: {
    title: 'Подтвердите email',
    body: 'Мы отправили ссылку на {email}. Откройте её — эта страница продолжит сама.',
    noAddress: 'Мы отправили вам ссылку для подтверждения. Откройте её — эта страница продолжит сама.',
    hint: 'У ссылки есть срок. Если он истёк, отправьте новую — старая перестанет работать.',
    resend: 'Отправить ссылку ещё раз',
    sending: 'Отправляем…',
    sent: 'Отправлено. Проверьте почту и папку «Спам».',
    failed: 'Сейчас не получилось отправить письмо. Подождите минуту и попробуйте снова.',
    signOut: 'Выйти',
  },
};

export function VerifyEmailPage() {
  const { email, resendVerification, signOut } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await resendVerification();
      setNotice(copy.sent);
    } catch {
      setError(copy.failed);
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
      <div className="card">
        <p style={{ marginTop: 0 }}>
          {email ? copy.body.replace('{email}', email) : copy.noAddress}
        </p>
        <p className="notice">{copy.hint}</p>
        {notice ? <p role="status" className="notice">{notice}</p> : null}
        {error ? <p role="alert" className="notice warn">{error}</p> : null}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => { void resend(); }}>
            {busy ? copy.sending : copy.resend}
          </button>
          <button type="button" onClick={() => { void signOut(); }}>{copy.signOut}</button>
        </div>
      </div>
    </div>
  );
}
