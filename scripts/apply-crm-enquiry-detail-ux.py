from pathlib import Path

page = Path('admin/src/pages/EnquiryDetailPage.tsx')
text = page.read_text()
old = '''      <Section title={t('enquiry.contactSubmitted')}>
        <dl className="definition">
          <dt>{t('enquiry.name')}</dt><dd>{enquiry.submitted_full_name ?? client?.full_name ?? '—'}</dd>
          <dt>{t('enquiry.email')}</dt><dd>{enquiry.submitted_email ?? client?.email ?? '—'}</dd>
          <dt>{t('enquiry.phone')}</dt><dd>{enquiry.submitted_phone ?? '—'}</dd>
          <dt>{t('enquiry.instagram')}</dt><dd>{enquiry.submitted_instagram ?? '—'}</dd>
          <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(enquiry.submitted_preferred_contact, language)}</dd>
          <dt>{t('enquiry.travellingFrom')}</dt><dd>{enquiry.submitted_travelling_from ?? '—'}</dd>
        </dl>
        {client ? (
          <div className="actions">
            <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openCurrentClient')}</Link>
          </div>
        ) : null}
      </Section>

      {client && contactDiffers ? (
        <Section title={t('enquiry.currentClient')}>
          <dl className="definition">
            <dt>{t('enquiry.name')}</dt><dd>{client.full_name}</dd>
            <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
            <dt>{t('enquiry.phone')}</dt><dd>{client.phone ?? '—'}</dd>
            <dt>{t('enquiry.instagram')}</dt><dd>{client.instagram ?? '—'}</dd>
            <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(client.preferred_contact, language)}</dd>
            <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
          </dl>
          <div className="actions">
            <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openClient')}</Link>
          </div>
        </Section>
      ) : null}
'''
new = '''      <Section title={t('enquiry.currentClient')}>
        {client ? (
          <>
            <dl className="definition">
              <dt>{t('enquiry.name')}</dt><dd>{client.full_name}</dd>
              <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
              <dt>{t('enquiry.phone')}</dt><dd>{client.phone ?? '—'}</dd>
              <dt>{t('enquiry.instagram')}</dt><dd>{client.instagram ?? '—'}</dd>
              <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(client.preferred_contact, language)}</dd>
              <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
            </dl>
            <div className="actions">
              <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openClient')}</Link>
            </div>
          </>
        ) : (
          <EmptyState title={t('enquiry.clientUnavailable')} />
        )}

        <details className="submitted-snapshot">
          <summary>{t('enquiry.contactSubmitted')}</summary>
          <dl className="definition">
            <dt>{t('enquiry.name')}</dt><dd>{enquiry.submitted_full_name ?? '—'}</dd>
            <dt>{t('enquiry.email')}</dt><dd>{enquiry.submitted_email ?? '—'}</dd>
            <dt>{t('enquiry.phone')}</dt><dd>{enquiry.submitted_phone ?? '—'}</dd>
            <dt>{t('enquiry.instagram')}</dt><dd>{enquiry.submitted_instagram ?? '—'}</dd>
            <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(enquiry.submitted_preferred_contact, language)}</dd>
            <dt>{t('enquiry.travellingFrom')}</dt><dd>{enquiry.submitted_travelling_from ?? '—'}</dd>
          </dl>
        </details>
      </Section>
'''
assert old in text, 'contact block not found'
text = text.replace(old, new, 1)
old = "              {files.filter((file) => file.upload_state === 'ready').map((file) => <SignedImage key={file.id} file={file} />)}"
new = '''              {files.filter((file) => file.upload_state === 'ready').map((file) => (
                <SignedImage
                  key={file.id}
                  file={file}
                  removeDisabled={busy}
                  onRemove={can(role, 'removeEnquiryFiles')
                    ? () => { void run(() => api.removeEnquiryReference(file)); }
                    : undefined}
                />
              ))}'''
assert old in text, 'reference image map not found'
page.write_text(text.replace(old, new, 1))

Path('admin/src/components/SignedImage.tsx').write_text("""// A private reference image.
//
// The signed URL is minted on render and expires within a minute. The compact
// preview stays inside the CRM; a deliberate click opens the same short-lived
// URL at its original resolution in a new tab.

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
        onClick={() => { window.open(url, '_blank', 'noopener,noreferrer'); }}
      >
        <img
          src={url}
          alt={t('image.alt', { filename })}
          loading="lazy"
          decoding="async"
        />
      </button>
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
""")

actions = Path('admin/src/components/EnquiryReferenceActions.tsx')
text = actions.read_text()
text = text.replace("  api: Pick<RecordEditApi, 'addEnquiryReference' | 'finalizeEnquiryReference' | 'removeEnquiryReference'>;", "  api: Pick<RecordEditApi, 'addEnquiryReference' | 'finalizeEnquiryReference'>;")
text = text.replace("  const canRemove = can(role, 'removeEnquiryFiles');\n", "")
text = text.replace("    remove: 'Удалить',\n", "")
text = text.replace("    remove: 'Remove',\n", "")
text = text.replace("  if (!can(role, 'manageEnquiryFiles') && !canRemove) return null;", "  if (!can(role, 'manageEnquiryFiles')) return null;")
remove_fn = '''
  async function remove(file: EnquiryFile) {
    setBusy(true);
    setError(null);
    try {
      await api.removeEnquiryReference(file);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }
'''
assert remove_fn in text, 'remove helper not found'
text = text.replace(remove_fn, '')
old = '''      {files.some((file) => file.upload_state !== 'ready') || canRemove ? (
        <div className="list" style={{ marginTop: 12 }}>
          {files.map((file) => (
            <div className="row" key={file.id}>
              <div className="title">{file.original_filename ?? `Reference ${file.ordinal + 1}`}</div>
              <div className="meta">
                {file.upload_state !== 'ready' && can(role, 'manageEnquiryFiles') ? (
                  <button type="button" disabled={busy} onClick={() => { void finish(file.id); }}>{copy.retry}</button>
                ) : null}
                {file.upload_state === 'ready' && canRemove ? (
                  <button type="button" disabled={busy} onClick={() => { void remove(file); }}>{copy.remove}</button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}'''
new = '''      {files.some((file) => file.upload_state !== 'ready') ? (
        <div className="list" style={{ marginTop: 12 }}>
          {files.filter((file) => file.upload_state !== 'ready').map((file) => (
            <div className="row" key={file.id}>
              <div className="title">{file.original_filename ?? `Reference ${file.ordinal + 1}`}</div>
              <div className="meta">
                <button type="button" disabled={busy} onClick={() => { void finish(file.id); }}>{copy.retry}</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}'''
assert old in text, 'reference action list not found'
actions.write_text(text.replace(old, new, 1))

i18n = Path('admin/src/lib/i18n.tsx')
text = i18n.read_text()
text = text.replace("  'enquiry.contactSubmitted': 'Contact submitted with this enquiry',", "  'enquiry.contactSubmitted': 'Submitted enquiry data',")
text = text.replace("  'enquiry.currentClient': 'Current client card',", "  'enquiry.currentClient': 'Current client details',")
text = text.replace("  'image.alt': 'Reference image submitted with this enquiry{filename}',", "  'image.alt': 'Reference image submitted with this enquiry{filename}',\n  'image.openOriginal': 'Open full-size reference{filename}',\n  'image.remove': 'Remove',")
text = text.replace("  'enquiry.contactSubmitted': 'Контакты из этой заявки',", "  'enquiry.contactSubmitted': 'Данные из исходной заявки',")
text = text.replace("  'enquiry.currentClient': 'Текущая карточка клиента',", "  'enquiry.currentClient': 'Актуальные данные клиента',")
text = text.replace("  'image.alt': 'Референс, отправленный с этой заявкой{filename}',", "  'image.alt': 'Референс, отправленный с этой заявкой{filename}',\n  'image.openOriginal': 'Открыть референс в полном размере{filename}',\n  'image.remove': 'Удалить',")
i18n.write_text(text)

styles = Path('admin/src/styles.css')
text = styles.read_text()
old = ".thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }\n.thumbs img { width: 100%; border-radius: 10px; border: 1px solid var(--border); display: block; }"
new = '''.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.thumbs img { width: 100%; border-radius: 10px; border: 1px solid var(--border); display: block; }
.reference-thumb { position: relative; min-width: 0; }
.reference-preview {
  width: 100%;
  min-height: 0;
  aspect-ratio: 4 / 5;
  display: block;
  overflow: hidden;
  padding: 0;
  border-radius: 10px;
  background: var(--surface-raised);
}
.reference-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 0;
  border-radius: 0;
}
.reference-thumb-remove {
  position: absolute;
  top: 7px;
  right: 7px;
  min-height: 32px;
  padding: 5px 9px;
  font-size: 0.72rem;
  background: rgba(0, 0, 0, 0.76);
}
.submitted-snapshot {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.submitted-snapshot summary {
  min-height: var(--tap);
  display: flex;
  align-items: center;
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.submitted-snapshot .definition { margin-top: 10px; }'''
assert old in text, 'thumb styles not found'
styles.write_text(text.replace(old, new, 1))

tests = Path('admin/src/test/record-edit-ui.test.tsx')
text = tests.read_text().replace("import { describe, expect, it } from 'vitest';", "import { describe, expect, it, vi } from 'vitest';")
insert = '''

  it('keeps the immutable submitted snapshot collapsed inside current client details', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    expect(await screen.findByText('Current client details')).toBeInTheDocument();
    const summary = screen.getByText('Submitted enquiry data');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('+447700900099')).toBeInTheDocument();
  });

  it('opens the original signed reference from its compact preview', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    const preview = await screen.findByRole('button', { name: 'Open full-size reference: reference-1.jpg' });
    fireEvent.click(preview);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('https://storage.example.test/signed/'),
      '_blank',
      'noopener,noreferrer'
    );
    open.mockRestore();
  });'''
marker = '\n});\n'
idx = text.rfind(marker)
assert idx != -1, 'test describe end not found'
tests.write_text(text[:idx] + insert + text[idx:])
