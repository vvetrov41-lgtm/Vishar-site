// A private reference image.
//
// The URL is minted on render and expires within a minute. It is deliberately
// not cached in state beyond the component, not put in a link a person could
// copy out of the page, and never logged.

import { useEffect, useState } from 'react';
import { useApi } from '../lib/session';
import type { EnquiryFile } from '../lib/types';

export function SignedImage({ file }: { file: EnquiryFile }) {
  const api = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    if (file.upload_state !== 'ready') {
      return () => { cancelled = true; };
    }
    api.signedFileUrl(file.storage_path)
      .then((signed) => { if (!cancelled) { if (signed) setUrl(signed); else setFailed(true); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [api, file.storage_path, file.upload_state]);

  if (file.upload_state !== 'ready') {
    return <div className="notice warn">This image did not finish uploading.</div>;
  }

  if (failed) {
    return <div className="notice">This image could not be opened. It may have expired — reload the page.</div>;
  }

  if (!url) {
    return <div className="notice" role="status">Opening image…</div>;
  }

  return (
    <img
      src={url}
      alt={`Reference image submitted with this enquiry${file.original_filename ? `: ${file.original_filename}` : ''}`}
      loading="lazy"
    />
  );
}
