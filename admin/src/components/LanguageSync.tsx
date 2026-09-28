// Records the interface language on the signed-in profile.
//
// The language switch lives in the browser, but Telegram pushes, server-written
// notifications and the AI's internal notes are produced on the server. They
// follow profiles.ui_language, so the server has to be told. Best effort: a
// failed write changes nothing on screen and is retried on the next change or
// sign-in.

import { useEffect, useRef } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi, useSession } from '../lib/session';

export function LanguageSync() {
  const api = useApi();
  const { profile } = useSession();
  const { language } = useLanguage();
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!profile?.id) return;
    const key = `${profile.id}:${language}`;
    if (sent.current === key) return;
    sent.current = key;
    Promise.resolve()
      .then(() => api.setMyUiLanguage(language))
      .catch(() => {
        sent.current = null;
      });
  }, [api, profile?.id, language]);

  return null;
}
