import { useLanguage, type Language } from '../lib/i18n';

export function LanguageSwitcher() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <label className="language-control">
      <span className="visually-hidden">{t('language.label')}</span>
      <select
        className="language-select"
        value={language}
        aria-label={t('language.label')}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        <option value="en">EN</option>
        <option value="ru">RU</option>
      </select>
    </label>
  );
}
