// Copy for the two-factor screens. Kept beside the feature, the way the login
// page keeps its recovery copy, so both languages ship together.

export const MFA_COPY = {
  en: {
    challengeTitle: 'Two-factor code',
    challengeHint: 'Open your authenticator app and enter the 6-digit code for Vishar CRM.',
    code: 'Code',
    verify: 'Verify',
    verifying: 'Checking…',
    signOut: 'Sign out',
    invalidCode: 'That code did not work. Check the time on your phone and try the newest code.',
    formatCode: 'Enter the 6 digits from your authenticator app.',
    unavailable: 'Two-factor authentication is unavailable right now. Try again in a minute.',
    lostDevice: 'Lost your authenticator? The account owner can remove the factor in Supabase Authentication → Users, after confirming it is really you.',
    sectionTitle: 'Two-factor authentication',
    sectionOn: 'On. A password alone cannot open this account.',
    sectionOff: 'Off. Anyone with your password can open this account.',
    sectionOwnerNudge: 'You own this CRM. Turn this on: it protects every client, payment and message.',
    start: 'Set up an authenticator',
    addBackup: 'Add a backup authenticator',
    scan: 'Scan this QR code with Google Authenticator, 1Password, Authy or a similar app, then enter the 6-digit code it shows.',
    secret: 'Or enter this key manually:',
    confirm: 'Turn on',
    cancel: 'Cancel',
    enrolled: 'Two-factor authentication is on.',
    remove: 'Remove',
    removeConfirm: 'Remove this authenticator? If it is your only one, two-factor authentication turns off.',
    removed: 'Authenticator removed.',
    factorName: 'Authenticator',
    backupHint: 'Tip: add a second authenticator (another phone or a password manager) so losing one device does not lock you out.',
    banner: 'Protect the CRM: turn on two-factor authentication in your account.',
    bannerLink: 'Open account',
  },
  ru: {
    challengeTitle: 'Код двухфакторной защиты',
    challengeHint: 'Откройте приложение-аутентификатор и введите 6-значный код для Vishar CRM.',
    code: 'Код',
    verify: 'Проверить',
    verifying: 'Проверяем…',
    signOut: 'Выйти',
    invalidCode: 'Код не подошёл. Проверьте время на телефоне и введите самый свежий код.',
    formatCode: 'Введите 6 цифр из приложения-аутентификатора.',
    unavailable: 'Двухфакторная защита сейчас недоступна. Попробуйте через минуту.',
    lostDevice: 'Потеряли аутентификатор? Владелец CRM может удалить фактор в Supabase: Authentication → Users, убедившись, что это действительно вы.',
    sectionTitle: 'Двухфакторная защита',
    sectionOn: 'Включена. Одного пароля недостаточно, чтобы войти.',
    sectionOff: 'Выключена. Любой, кто знает пароль, может войти в аккаунт.',
    sectionOwnerNudge: 'Вы владелец этой CRM. Включите защиту: она закрывает всех клиентов, платежи и переписку.',
    start: 'Подключить аутентификатор',
    addBackup: 'Добавить запасной аутентификатор',
    scan: 'Отсканируйте QR-код в Google Authenticator, 1Password, Authy или похожем приложении и введите 6-значный код.',
    secret: 'Или введите ключ вручную:',
    confirm: 'Включить',
    cancel: 'Отмена',
    enrolled: 'Двухфакторная защита включена.',
    remove: 'Удалить',
    removeConfirm: 'Удалить этот аутентификатор? Если он единственный, двухфакторная защита выключится.',
    removed: 'Аутентификатор удалён.',
    factorName: 'Аутентификатор',
    backupHint: 'Совет: добавьте второй аутентификатор (другой телефон или менеджер паролей), чтобы потеря одного устройства не закрыла доступ.',
    banner: 'Защитите CRM: включите двухфакторную защиту в аккаунте.',
    bannerLink: 'Открыть аккаунт',
  },
} as const;

export type MfaCopy = { [K in keyof typeof MFA_COPY.en]: string };

export function mfaCopy(language: string): MfaCopy {
  return language === 'ru' ? MFA_COPY.ru : MFA_COPY.en;
}

export function mfaErrorMessage(error: unknown, copy: MfaCopy): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'invalid_code') return copy.invalidCode;
  if (code === 'invalid_code_format') return copy.formatCode;
  return copy.unavailable;
}
