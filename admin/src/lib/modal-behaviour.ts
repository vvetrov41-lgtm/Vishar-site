import { useEffect, type RefObject } from 'react';

/**
 * The CRM's sheets behave like the confirmation dialog: Escape closes them,
 * the page behind does not scroll, focus moves into the sheet and returns to
 * whatever opened it.
 */
export function useModalBehaviour(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  canClose = true
) {
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTarget = containerRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusTarget?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, containerRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && canClose) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, canClose]);
}
