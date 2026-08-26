// A private reference image.
//
// The signed URL is minted on render and expires within a minute. The compact
// preview stays inside the CRM. A deliberate click mints a fresh short-lived
// URL before opening the original so a page left open cannot reuse an expired
// token.

import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { EnquiryFile } from '../lib/types';

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
  const { t } = useLanguage();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

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

  async function openOriginal() {
    setOpenFailed(false);

    // Open synchronously while the click still owns Safari's user gesture.
    // `noopener` would intentionally hide the returned Window handle, so clear
    // opener immediately instead and navigate this blank tab only after the
    // fresh signed URL arrives.
    const opened = window.open('about:blank', '_blank');
    if (!opened) {
      setOpenFailed(true);
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
      {onRemove ? (
        <button
          type="button"
          className="reference-thumb-remove danger"
          disabled={removeDisabled}
          onClick={onRemove}
        >
          {t('image.remove')}
        </button>
      ) : null}
    </div>
  );
}
