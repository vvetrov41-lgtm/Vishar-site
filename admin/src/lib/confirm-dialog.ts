// The CRM's one confirmation dialog.
//
// A styled `alertdialog` was introduced for the eight consequential RPCs, but
// features added afterwards reached for window.confirm again, so the product
// asked for confirmation in two visibly different ways - one of them labelled
// with the browser's hostname. This module owns the implementation; every
// confirmation in the CRM goes through it.
//
// Native dialog modality supplies focus containment and Escape support; the
// explicit handlers preserve a safe cancel path and restore page scrolling.
// Cancel is focused first, so the default action of a confirmation is always
// the reversible one.

import './consequential-dialog.css';

export type ConfirmTone = 'danger' | 'primary';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmTone;
}

let dialogSequence = 0;

function nextDialogId(prefix: string): string {
  dialogSequence += 1;
  return `${prefix}-${dialogSequence}`;
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

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  // Without a document there is nothing to confirm against, and silently
  // proceeding would be the dangerous answer.
  if (typeof document === 'undefined') return Promise.resolve(false);

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
    const title = appendTextElement(content, 'h2', request.title);
    title.id = titleId;
    const description = appendTextElement(content, 'p', request.message);
    description.id = descriptionId;

    const actions = document.createElement('div');
    actions.className = 'consequential-dialog-actions';

    const cancelButton = appendTextElement(
      actions,
      'button',
      request.cancelLabel,
      'consequential-dialog-cancel'
    );
    cancelButton.type = 'button';

    const confirmButton = appendTextElement(
      actions,
      'button',
      request.confirmLabel,
      request.tone === 'primary'
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
 * The shared cancel wording, so a caller only has to name the action it is
 * asking about.
 */
export function cancelLabelFor(language: 'en' | 'ru'): string {
  return language === 'ru' ? 'Назад' : 'Go back';
}
