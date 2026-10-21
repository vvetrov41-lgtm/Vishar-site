// A private reference image.
//
// The signed URL is minted on render and expires within a minute. The compact
// preview stays inside the CRM. A deliberate click mints a fresh short-lived
// URL before opening the original so a page left open cannot reuse an expired
// token.
//
// In-app browsers (Telegram, Instagram, Facebook, Android WebViews) either
// block window.open or hand back a window that never navigates, so there the
// original is shown in a full-screen viewer inside the CRM instead of a tab.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { useModalBehaviour } from '../lib/modal-behaviour';
import type { EnquiryFile } from '../lib/types';

/** True inside an embedded browser where a new tab cannot be relied on. */
export function isEmbeddedBrowser(
  win: Window = window,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  const injected = win as unknown as Record<string, unknown>;
  if (injected.TelegramWebviewProxy || injected.TelegramWebview) return true;
  return /Telegram|FBAN|FBAV|Instagram|; wv\)/.test(userAgent);
}

export function SignedImage({
  file,
  onRemove,
  removeDisabled = false,
}: {
  file: EnquiryFile;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  const api = useApi();
  const { t, language } = useLanguage();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    setOpenFailed(false);
    if (file.upload_state !== 'ready') {
      return () => { cancelled = true; };
    }
    api.signedFileUrl(file.storage_path)
      .then((signed) => { if (!cancelled) { if (signed) setUrl(signed); else setFailed(true); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [api, file.storage_path, file.upload_state]);

  async function openInViewer() {
    try {
      const freshUrl = await api.signedFileUrl(file.storage_path);
      if (!freshUrl) {
        setOpenFailed(true);
        return;
      }
      setUrl(freshUrl);
      setViewerUrl(freshUrl);
    } catch {
      setOpenFailed(true);
    }
  }

  async function openOriginal() {
    setOpenFailed(false);

    if (isEmbeddedBrowser()) {
      await openInViewer();
      return;
    }

    // Open synchronously while the click still owns Safari's user gesture.
    // `noopener` would intentionally hide the returned Window handle, so clear
    // opener immediately instead and navigate this blank tab only after the
    // fresh signed URL arrives.
    const opened = window.open('about:blank', '_blank');
    if (!opened) {
      // A blocked popup: show the original here rather than an error.
      await openInViewer();
      return;
    }
    opened.opener = null;

    try {
      const freshUrl = await api.signedFileUrl(file.storage_path);
      if (!freshUrl) {
        opened.close();
        setOpenFailed(true);
        return;
      }
      setUrl(freshUrl);
      opened.location.replace(freshUrl);
    } catch {
      opened.close();
      setOpenFailed(true);
    }
  }

  async function removeReference() {
    if (!onRemove) return;
    const approved = await confirmDialog({
      title: language === 'ru' ? 'Удалить референс?' : 'Remove reference?',
      message: language === 'ru'
        ? 'Изображение исчезнет из этой заявки.'
        : 'This image will be removed from the enquiry.',
      confirmLabel: t('image.remove'),
      cancelLabel: cancelLabelFor(language),
      tone: 'danger',
    });
    if (approved) onRemove();
  }

  if (file.upload_state !== 'ready') {
    return <div className="notice warn">{t('image.uploadFailed')}</div>;
  }

  if (failed) {
    return <div className="notice">{t('image.openFailed')}</div>;
  }

  if (!url) {
    return <div className="notice" role="status">{t('image.opening')}</div>;
  }

  const filename = file.original_filename ? `: ${file.original_filename}` : '';

  return (
    <div className="reference-thumb">
      <button
        type="button"
        className="reference-preview"
        aria-label={t('image.openOriginal', { filename })}
        title={t('image.openOriginal', { filename })}
        onClick={() => { void openOriginal(); }}
      >
        <img
          src={url}
          alt={t('image.alt', { filename })}
          loading="lazy"
          decoding="async"
        />
      </button>
      {openFailed ? <div className="notice">{t('image.openFailed')}</div> : null}
      {viewerUrl ? (
        <ReferenceViewer
          url={viewerUrl}
          alt={t('image.alt', { filename })}
          closeLabel={t('image.close')}
          onClose={() => setViewerUrl(null)}
        />
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="reference-thumb-remove danger"
          aria-label={t('image.remove')}
          title={t('image.remove')}
          disabled={removeDisabled}
          onClick={() => { void removeReference(); }}
        >
          ⋯
        </button>
      ) : null}
    </div>
  );
}

function ReferenceViewer({
  url, alt, closeLabel, onClose,
}: { url: string; alt: string; closeLabel: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useModalBehaviour(true, ref, close);
  return (
    <div
      ref={ref}
      className="reference-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <button type="button" className="reference-viewer-close" onClick={close}>
        {closeLabel}
      </button>
      <img src={url} alt={alt} />
    </div>
  );
}
