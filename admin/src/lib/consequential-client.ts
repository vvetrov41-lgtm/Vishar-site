import type { CrmClient } from './api';
import type { Language } from './i18n';
import './consequential-dialog.css';

export type ConsequentialAction =
  | 'convertEnquiry'
  | 'cancelSession'
  | 'markNoShow'
  | 'cancelAppointment'
  | 'markAppointmentNoShow'
  | 'deactivateUser';

const COPY: Record<Language, Record<ConsequentialAction, string>> = {
  en: {
    convertEnquiry: 'Convert this enquiry to a project? This creates a permanent project link and cannot be undone.',
    cancelSession: 'Cancel this session? It will be removed from the active schedule.',
    markNoShow: 'Mark this session as a no-show? This records that the client did not attend.',
    cancelAppointment: 'Cancel this appointment? It will be removed from the active schedule.',
    markAppointmentNoShow: 'Mark this appointment as a no-show? This records that the client did not attend.',
    deactivateUser: 'Deactivate this user? Their CRM access will be withdrawn immediately.',
  },
  ru: {
    convertEnquiry: 'Преобразовать эту заявку в проект? Будет создана постоянная связь с проектом, которую нельзя отменить.',
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
    cancelSession: 'Cancel session?',
    markNoShow: 'Record no-show?',
    cancelAppointment: 'Cancel appointment?',
    markAppointmentNoShow: 'Record no-show?',
    deactivateUser: 'Deactivate user?',
  },
  ru: {
    convertEnquiry: 'Создать проект?',
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
    cancelSession: 'Cancel session',
    markNoShow: 'Mark no-show',
    cancelAppointment: 'Cancel appointment',
    markAppointmentNoShow: 'Mark no-show',
    deactivateUser: 'Deactivate user',
  },
  ru: {
    convertEnquiry: 'Создать проект',
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

let dialogSequence = 0;

function nextDialogId(prefix: string): string {
  dialogSequence += 1;
  return `${prefix}-${dialogSequence}`;
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
  if (name === 'set_appointment_status' && args?.p_status === 'cancelled') return 'cancelAppointment';
  if (name === 'set_appointment_status' && args?.p_status === 'no_show') return 'markAppointmentNoShow';
  if (name === 'set_profile_active' && args?.p_is_active === false) return 'deactivateUser';
  return null;
}

function appendTextElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  text: string,
  className?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

/**
 * Shows a CRM-owned modal rather than the browser's hostname-labelled confirm
 * prompt. Native dialog modality supplies focus containment and Escape support;
 * the explicit handlers preserve a safe cancel path and restore page scrolling.
 */
export function showConsequentialDialog(
  message: string,
  action: ConsequentialAction,
  language: Language
): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    const titleId = nextDialogId('consequential-title');
    const descriptionId = nextDialogId('consequential-description');
    const previousOverflow = document.body.style.overflow;
    let settled = false;

    dialog.className = 'consequential-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descriptionId);

    const content = document.createElement('div');
    content.className = 'consequential-dialog-content';
    const title = appendTextElement(content, 'h2', TITLES[language][action]);
    title.id = titleId;
    const description = appendTextElement(content, 'p', message);
    description.id = descriptionId;

    const actions = document.createElement('div');
    actions.className = 'consequential-dialog-actions';

    const cancelButton = appendTextElement(
      actions,
      'button',
      language === 'ru' ? 'Назад' : 'Go back',
      'consequential-dialog-cancel'
    );
    cancelButton.type = 'button';

    const confirmButton = appendTextElement(
      actions,
      'button',
      CONFIRM_LABELS[language][action],
      action === 'convertEnquiry'
        ? 'primary consequential-dialog-confirm'
        : 'danger consequential-dialog-confirm'
    );
    confirmButton.type = 'button';

    content.append(actions);
    dialog.append(content);

    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      document.body.style.overflow = previousOverflow;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.remove();
      resolve(approved);
    };

    cancelButton.addEventListener('click', () => finish(false));
    confirmButton.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });

    document.body.append(dialog);
    document.body.style.overflow = 'hidden';

    try {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } catch {
      dialog.setAttribute('open', '');
    }

    queueMicrotask(() => cancelButton.focus());
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
