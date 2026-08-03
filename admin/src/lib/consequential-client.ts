import type { CrmClient } from './api';
import type { Language } from './i18n';

export type ConsequentialAction =
  | 'convertEnquiry'
  | 'cancelSession'
  | 'markNoShow'
  | 'deactivateUser';

const COPY: Record<Language, Record<ConsequentialAction, string>> = {
  en: {
    convertEnquiry: 'Convert this enquiry to a project? This creates a permanent project link and cannot be undone.',
    cancelSession: 'Cancel this session? It will be removed from the active schedule.',
    markNoShow: 'Mark this session as a no-show? This records that the client did not attend.',
    deactivateUser: 'Deactivate this user? Their CRM access will be withdrawn immediately.',
  },
  ru: {
    convertEnquiry: 'Преобразовать эту заявку в проект? Будет создана постоянная связь с проектом, которую нельзя отменить.',
    cancelSession: 'Отменить этот сеанс? Он будет удалён из активного расписания.',
    markNoShow: 'Отметить неявку на этот сеанс? Будет записано, что клиент не пришёл.',
    deactivateUser: 'Деактивировать пользователя? Его доступ к CRM будет отозван немедленно.',
  },
};

interface ConfirmationOptions {
  confirm?: (message: string) => boolean;
  language?: () => Language;
}

function currentLanguage(): Language {
  try {
    const saved = window.localStorage.getItem('vishar-crm-language');
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    // Use the browser language when storage is unavailable.
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function consequentialAction(
  name: string,
  args: Record<string, unknown> | undefined
): ConsequentialAction | null {
  if (name === 'convert_enquiry_to_project') return 'convertEnquiry';
  if (name === 'set_session_status' && args?.p_status === 'cancelled') return 'cancelSession';
  if (name === 'set_session_status' && args?.p_status === 'no_show') return 'markNoShow';
  if (name === 'set_profile_active' && args?.p_is_active === false) return 'deactivateUser';
  return null;
}

/**
 * Adds a last client-side confirmation immediately before consequential RPCs.
 * Database role checks and RLS remain authoritative; declining a prompt simply
 * prevents the RPC from being sent. Ordinary workflow actions pass through.
 */
export function withConsequentialConfirmations(
  client: CrmClient | null,
  options: ConfirmationOptions = {}
): CrmClient | null {
  if (!client) return null;

  const ask = options.confirm ?? ((message: string) => window.confirm(message));
  const language = options.language ?? currentLanguage;

  return {
    from: client.from.bind(client),
    storage: client.storage,
    auth: client.auth,
    rpc: async (name, args) => {
      const action = consequentialAction(name, args);
      if (action && !ask(COPY[language()][action])) {
        return { data: null, error: null };
      }
      return client.rpc(name, args);
    },
  };
}
