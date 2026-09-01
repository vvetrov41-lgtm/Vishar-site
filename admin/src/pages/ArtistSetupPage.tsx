// First run: turn a confirmed account into a working CRM.
//
// Two questions and a Continue. Everything the platform actually needs - a
// profile, a solo organization, an artist, workspace ownership, the seat on
// their own book - is created by one server call from these answers, and none
// of those words appear on this screen. A tattoo artist setting up their book
// should not have to learn what a workspace membership is.
//
// The timezone is detected rather than asked for. Getting it wrong moves every
// appointment they will ever make, and a person who has just typed their name
// twice is not the right moment to explain IANA zone identifiers - so it is
// shown, editable, and validated server-side, where an unrecognised zone falls
// back rather than failing the form.

import { useMemo, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useLanguage, type Language } from '../lib/i18n';
import { useRouter } from '../lib/router';
import { useSession } from '../lib/session';

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Set up your CRM',
    intro: 'Two things, then you are in.',
    name: 'Your name',
    nameHint: 'How clients see you. You can change it later.',
    business: 'Business or studio name',
    businessHint: 'Optional. Leave it blank if you work under your own name.',
    timezone: 'Time zone',
    timezoneHint: 'Detected from this device. Appointments and reminders use it.',
    submit: 'Continue',
    working: 'Setting up…',
    nameProblem: 'Enter the name clients should see.',
    failed: 'Could not finish setting up. Nothing was created — try again.',
    signOut: 'Sign out',
  },
  ru: {
    title: 'Настройте CRM',
    intro: 'Два поля — и можно работать.',
    name: 'Ваше имя',
    nameHint: 'Так вас видят клиенты. Можно изменить позже.',
    business: 'Название студии или бизнеса',
    businessHint: 'Необязательно. Оставьте пустым, если работаете под своим именем.',
    timezone: 'Часовой пояс',
    timezoneHint: 'Определён по этому устройству. По нему считаются записи и напоминания.',
    submit: 'Продолжить',
    working: 'Настраиваем…',
    nameProblem: 'Введите имя, которое увидят клиенты.',
    failed: 'Не удалось завершить настройку. Ничего не создано — попробуйте ещё раз.',
    signOut: 'Выйти',
  },
};

function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  } catch {
    return 'Europe/London';
  }
}

function knownTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }).supportedValuesOf;
    return typeof supported === 'function' ? supported('timeZone') : [];
  } catch {
    return [];
  }
}

export function ArtistSetupPage() {
  const { completeArtistSetup, signOut } = useSession();
  const { navigate } = useRouter();
  const { language } = useLanguage();
  const copy = COPY[language];

  const [name, setName] = useState('');
  const [business, setBusiness] = useState('');
  const [timezone, setTimezone] = useState(detectedTimeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zones = useMemo(knownTimeZones, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const displayName = name.trim();
    if (!displayName) {
      setError(copy.nameProblem);
      return;
    }

    setBusy(true);
    try {
      const result = await completeArtistSetup({
        displayName,
        businessName: business.trim() || null,
        timezone: timezone.trim() || null,
      });
      // Straight to their own checklist. It is derived from live state, so it
      // opens already knowing what is done and what is left - which is a
      // better first screen than an empty dashboard.
      navigate(`/artists/${result.artist_id}`);
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
        <label htmlFor="setup-name">{copy.name}</label>
        <input
          id="setup-name"
          name="display-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <p className="notice">{copy.nameHint}</p>

        <label htmlFor="setup-business">{copy.business}</label>
        <input
          id="setup-business"
          name="business-name"
          type="text"
          autoComplete="organization"
          maxLength={120}
          value={business}
          onChange={(event) => setBusiness(event.target.value)}
        />
        <p className="notice">{copy.businessHint}</p>

        <label htmlFor="setup-timezone">{copy.timezone}</label>
        <input
          id="setup-timezone"
          name="timezone"
          type="text"
          list="setup-timezone-options"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
        {zones.length > 0 ? (
          <datalist id="setup-timezone-options">
            {zones.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        ) : null}
        <p className="notice">{copy.timezoneHint}</p>

        {error ? <p role="alert" className="notice warn">{error}</p> : null}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? copy.working : copy.submit}
          </button>
        </div>
      </form>

      <div className="actions" style={{ justifyContent: 'center' }}>
        <button type="button" onClick={() => { void signOut(); }}>{copy.signOut}</button>
      </div>
    </div>
  );
}
