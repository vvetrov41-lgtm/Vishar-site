// The shared confirmation dialog's own behaviour.

import { afterEach, describe, expect, it } from 'vitest';
import { confirmDialog } from '../lib/confirm-dialog';

afterEach(() => {
  document.querySelectorAll('dialog').forEach((node) => node.remove());
  document.body.style.overflow = '';
});

function open() {
  return confirmDialog({
    title: 'Cancel appointment?',
    message: 'It will be removed from the active schedule.',
    confirmLabel: 'Cancel appointment',
    cancelLabel: 'Go back',
  });
}

function dialog(): HTMLDialogElement {
  const node = document.querySelector('dialog');
  if (!node) throw new Error('no dialog rendered');
  return node as HTMLDialogElement;
}

describe('confirmDialog', () => {
  it('announces itself as a modal alert dialog with its title and message', async () => {
    const pending = open();
    const node = dialog();

    expect(node.getAttribute('role')).toBe('alertdialog');
    expect(node.getAttribute('aria-modal')).toBe('true');
    expect(node.querySelector('h2')?.textContent).toBe('Cancel appointment?');
    expect(node.querySelector('p')?.textContent).toBe('It will be removed from the active schedule.');
    // Labelled by its own nodes, not by an index into a shared list.
    expect(node.getAttribute('aria-labelledby')).toBe(node.querySelector('h2')?.id);
    expect(node.getAttribute('aria-describedby')).toBe(node.querySelector('p')?.id);

    node.querySelector<HTMLButtonElement>('.consequential-dialog-cancel')?.click();
    await pending;
  });

  it('resolves true only when the confirming control is used', async () => {
    const pending = open();
    dialog().querySelector<HTMLButtonElement>('.consequential-dialog-confirm')?.click();
    expect(await pending).toBe(true);
  });

  it('treats going back as a decline', async () => {
    const pending = open();
    dialog().querySelector<HTMLButtonElement>('.consequential-dialog-cancel')?.click();
    expect(await pending).toBe(false);
  });

  it('treats a backdrop click as a decline', async () => {
    const pending = open();
    const node = dialog();
    node.dispatchEvent(new MouseEvent('click', { bubbles: false }));
    expect(await pending).toBe(false);
  });

  it('restores page scrolling and removes itself once answered', async () => {
    document.body.style.overflow = 'auto';
    const pending = open();
    expect(document.body.style.overflow).toBe('hidden');

    dialog().querySelector<HTMLButtonElement>('.consequential-dialog-cancel')?.click();
    await pending;

    expect(document.body.style.overflow).toBe('auto');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('marks a destructive action by default and a stated one as primary', async () => {
    const destructive = open();
    expect(dialog().querySelector('.consequential-dialog-confirm')?.className).toContain('danger');
    dialog().querySelector<HTMLButtonElement>('.consequential-dialog-cancel')?.click();
    await destructive;

    const primary = confirmDialog({
      title: 'Confirm this payment?',
      message: 'It will be recorded against the client.',
      confirmLabel: 'Confirm payment',
      cancelLabel: 'Go back',
      tone: 'primary',
    });
    expect(dialog().querySelector('.consequential-dialog-confirm')?.className).toContain('primary');
    dialog().querySelector<HTMLButtonElement>('.consequential-dialog-cancel')?.click();
    await primary;
  });
});
