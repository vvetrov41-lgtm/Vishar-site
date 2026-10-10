// The client's original request, shown on the project it became.
//
// A project keeps only enquiry_id; nothing is copied. After a booking the
// artist still sees the body areas, kinds of work, styles, the client's own
// words and every reference photo, read live from the source enquiry. One
// enquiry with several body areas stays one project: splitting is the
// artist's decision, made by creating further projects by hand.
//
// Loaded separately from the project so a slow or refused enquiry read never
// blocks the project page.

import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { can } from '../lib/permissions';
import { useApi } from '../lib/session';
import { enquiryHeadline } from '../lib/enquiry-summary';
import { imageGroups } from '../lib/enquiry-images';
import type { CrmRole, Enquiry, EnquiryFile } from '../lib/types';
import { ClientBrief } from './ClientBrief';
import { EnquiryProjectDetails, isStructuredProjectDetails } from './EnquiryProjectDetails';
import { SignedImage } from './SignedImage';
import { Section } from './StateViews';

const COPY = {
  en: { title: 'Original request', unavailable: 'The original enquiry could not be loaded.', clientWords: 'Client\'s description', photos: 'Photos from the enquiry', none: 'No photos' },
  ru: { title: 'Исходная заявка', unavailable: 'Не удалось загрузить исходную заявку.', clientWords: 'Описание клиента', photos: 'Фото из заявки', none: 'Нет фото' },
} as const;

export function ProjectSourceEnquiry({ enquiryId, role }: { enquiryId: string; role: CrmRole | null | undefined }) {
  const api = useApi();
  const { t, language } = useLanguage();
  const copy = COPY[language] ?? COPY.en;
  const mayViewFiles = can(role, 'viewEnquiryFiles');
  const [enquiry, setEnquiry] = useState<Enquiry | null>(null);
  const [files, setFiles] = useState<EnquiryFile[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    Promise.all([
      api.getEnquiry(enquiryId),
      mayViewFiles ? api.listEnquiryFiles(enquiryId) : Promise.resolve([] as EnquiryFile[]),
    ])
      .then(([loaded, loadedFiles]) => {
        if (cancelled) return;
        setEnquiry(loaded);
        setFiles(loadedFiles.filter((file) => file.upload_state === 'ready'));
        if (!loaded) setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [api, enquiryId, mayViewFiles]);

  if (!can(role, 'viewEnquiries')) return null;

  return (
    <Section title={copy.title} id="project-source-enquiry">
      {failed ? <p className="meta">{copy.unavailable}</p> : null}
      {enquiry ? (
        <div data-testid="project-source-enquiry">
          {enquiryHeadline(enquiry) ? <p style={{ fontWeight: 600, marginTop: 0 }}>{enquiryHeadline(enquiry)}</p> : null}
          {isStructuredProjectDetails(enquiry.project_details) ? (
            <EnquiryProjectDetails details={enquiry.project_details} language={language} />
          ) : (
            <dl className="definition">
              <dt>{t('enquiry.placement')}</dt><dd>{enquiry.placement ?? '—'}</dd>
              <dt>{t('enquiry.size')}</dt><dd>{enquiry.approximate_size ?? '—'}</dd>
              <dt>{t('enquiry.coverUp')}</dt><dd>{enquiry.cover_up ?? '—'}</dd>
            </dl>
          )}
          <div className="meta" style={{ fontWeight: 600, marginTop: 12 }}>{copy.clientWords}</div>
          <ClientBrief text={enquiry.idea} language={language} />
          {mayViewFiles ? (
            <>
              <div className="meta" style={{ fontWeight: 600, marginTop: 12 }}>{copy.photos} ({files.length})</div>
              {files.length === 0 ? <p className="meta">{copy.none}</p> : imageGroups(files).map((group) => (
                <div key={group.key} data-testid={`project-source-images-${group.key}`}>
                  {group.titleKey ? (
                    <div className="meta" style={{ margin: '8px 0 4px' }}>{t(group.titleKey)} ({group.files.length})</div>
                  ) : null}
                  <div className="thumbs">
                    {group.files.map((file) => <SignedImage key={file.id} file={file} />)}
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
