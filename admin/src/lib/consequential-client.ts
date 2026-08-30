import type { CrmClient } from './api';
import { cancelLabelFor, confirmDialog } from './confirm-dialog';
import type { Language } from './i18n';

export type ConsequentialAction =
  | 'convertEnquiry'
  | 'archiveEnquiry'
  | 'archiveClient'
  | 'cancelSession'
  | 'markNoShow'
  | 'cancelAppointment'
  | 'markAppointmentNoShow'
  | 'deactivateUser';

const COPY: Record<Language, Record<ConsequentialAction, string>> = {
  en: {
    convertEnquiry: 'Convert this enquiry to a project? This creates a permanent project link and cannot be undone.',
    archiveEnquiry: 'Delete this enquiry from the working CRM? The record and its history will be retained for audit and recovery, but it will disappear from normal enquiry lists.',
    archiveClient: 'Delete this client from the working CRM? The record and any unconverted enquiries will be retained for audit and recovery, but they will disappear from normal lists.',
    cancelSession: 'Cancel this session? It will be removed from the active schedule.',
    markNoShow: 'Mark this session as a no-show? This records that the client did not attend.',
    cancelAppointment: 'Cancel this appointment? It will be removed from the active schedule.',
    markAppointmentNoShow: 'Mark this appointment as a no-show? This records that the client did not attend.',
    deactivateUser: 'Deactivate this user? Their CRM access will be withdrawn immediately.',
  },
  ru: {
    convertEnquiry: 'Преобразовать эту заявку в проект? Будет создана постоянная связь с проектом, которую нельзя отменить.',
    archiveEnquiry: 'Удалить эту заявку из рабочей CRM? Запись и история сохранятся для аудита и восстановления, но заявка исчезнет из обычных списков.',
    archiveClient: 'Удалить этого клиента из рабочей CRM? Запись и его незавершённые заявки сохранятся для аудита и восстановления, но исчезнут из обычных списков.',
    cancelSession: 'Отменить этот сеанс? Он будет удалён из активного расписания.',
    markNoShow: 'Отметить неявку на этот сеанс? Будет записано, что клиент не пришёл.',
    cancelAppointment: 'Отменить эту запись? Она будет удалена из активного расписания.',
    markAppointmentNoShow: 'Отметить неявку на эту запись? Будет записано, что клиент не пришёл.',
    deactivateUser: 'Деактивировать пользователя? Его доступ к CRM будет отозван немедленно.',
  },
};

const TITLES: Record<Language, Record<ConsequentialAction, string>> = {
  en: {
    convertEnquiry: 'Create project?',
    archiveEnquiry: 'Delete enquiry?',
    archiveClient: 'Delete client?',
    cancelSession: 'Cancel session?',
    markNoShow: 'Record no-show?',
    cancelAppointment: 'Cancel appointment?',
    markAppointmentNoShow: 'Record no-show?',
    deactivateUser: 'Deactivate user?',
  },
  ru: {
    convertEnquiry: 'Создать проект?',
    archiveEnquiry: 'Удалить заявку?',
    archiveClient: 'Удалить клиента?',
    cancelSession: 'Отменить сеанс?',
    markNoShow: 'Отметить неявку?',
    cancelAppointment: 'Отменить запись?',
    markAppointmentNoShow: 'Отметить неявку?',
    deactivateUser: 'Деактивировать пользователя?',
  },
};

const CONFIRM_LABELS: Record<Language, Record<ConsequentialAction, string>> = {
  en: {
    convertEnquiry: 'Create project',
    archiveEnquiry: 'Delete enquiry',
    archiveClient: 'Delete client',
    cancelSession: 'Cancel session',
    markNoShow: 'Mark no-show',
    cancelAppointment: 'Cancel appointment',
    markAppointmentNoShow: 'Mark no-show',
    deactivateUser: 'Deactivate user',
  },
  ru: {
    convertEnquiry: 'Создать проект',
    archiveEnquiry: 'Удалить заявку',
    archiveClient: 'Удалить клиента',
    cancelSession: 'Отменить сеанс',
    markNoShow: 'Отметить неявку',
    cancelAppointment: 'Отменить запись',
    markAppointmentNoShow: 'Отметить неявку',
    deactivateUser: 'Деактивировать',
  },
};

interface ConfirmationOptions {
  confirm?: (
    message: string,
    action?: ConsequentialAction,
    language?: Language
  ) => boolean | Promise<boolean>;
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

function hasArchiveCommand(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>)._archive === true;
}

function consequentialAction(
  name: string,
  args: Record<string, unknown> | undefined
): ConsequentialAction | null {
  if (name === 'convert_enquiry_to_project') return 'convertEnquiry';
  if (name === 'update_enquiry_details' && hasArchiveCommand(args?.p_enquiry)) return 'archiveEnquiry';
  if (name === 'update_client_details' && hasArchiveCommand(args?.p_client)) return 'archiveClient';
  if (name === 'set_session_status' && args?.p_status === 'cancelled') return 'cancelSession';
  if (name === 'set_session_status' && args?.p_status === 'no_show') return 'markNoShow';
  if (name === 'set_appointment_status' && args?.p_status === 'cancelled') return 'cancelAppointment';
  if (name === 'set_appointment_status' && args?.p_status === 'no_show') return 'markAppointmentNoShow';
  if (name === 'set_profile_active' && args?.p_is_active === false) return 'deactivateUser';
  return null;
}

/**
 * The RPC-level confirmations, expressed through the shared dialog. The copy
 * for these lives here because it is keyed to the operation the database is
 * about to be asked to perform, not to the screen that asked.
 */
export function showConsequentialDialog(
  message: string,
  action: ConsequentialAction,
  language: Language
): Promise<boolean> {
  return confirmDialog({
    title: TITLES[language][action],
    message,
    confirmLabel: CONFIRM_LABELS[language][action],
    cancelLabel: cancelLabelFor(language),
    tone: action === 'convertEnquiry' ? 'primary' : 'danger',
  });
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

  const ask = options.confirm ?? showConsequentialDialog;
  const language = options.language ?? currentLanguage;

  return {
    from: client.from.bind(client),
    storage: client.storage,
    auth: client.auth,
    rpc: async (name, args) => {
      const action = consequentialAction(name, args);
      if (action) {
        const selectedLanguage = language();
        const approved = await ask(COPY[selectedLanguage][action], action, selectedLanguage);
        if (!approved) return { data: null, error: null };
      }
      return client.rpc(name, args);
    },
  };
}
