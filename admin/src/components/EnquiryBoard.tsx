import { Link } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import {
  ENQUIRY_BOARD_COLUMNS,
  boardMoveTargets,
  groupEnquiriesForBoard,
  type EnquiryBoardColumnKey,
} from '../lib/enquiry-board';
import { enquiryBrief } from '../lib/enquiry-summary';
import type { CrmRole, Enquiry, EnquiryStatus, StatusTransition } from '../lib/types';

const COLUMN_LABEL_KEY: Record<EnquiryBoardColumnKey, string> = {
  new: 'enquiries.boardNew',
  waiting: 'enquiries.boardWaiting',
  ready: 'enquiries.boardReady',
  deposit: 'enquiries.boardDeposit',
  booked: 'enquiries.boardBooked',
};

export function EnquiryBoard({
  enquiries,
  clientNames,
  transitions,
  role,
  movingEnquiryId,
  onMove,
}: {
  enquiries: Enquiry[];
  clientNames: Map<string, string>;
  transitions: StatusTransition[];
  role: CrmRole | null | undefined;
  movingEnquiryId: string | null;
  onMove: (enquiry: Enquiry, to: EnquiryStatus) => void | Promise<void>;
}) {
  const { t, label, language } = useLanguage();
  const groups = groupEnquiriesForBoard(enquiries);

  return (
    <div className="enquiry-board" aria-label={t('enquiries.boardLabel')}>
      {ENQUIRY_BOARD_COLUMNS.map((column) => (
        <section className="enquiry-board-column" key={column.key}>
          <header className="enquiry-board-column-header">
            <h2>{t(COLUMN_LABEL_KEY[column.key])}</h2>
            <span className="badge">{groups[column.key].length}</span>
          </header>

          <div className="enquiry-board-stack">
            {groups[column.key].length === 0 ? (
              <p className="enquiry-board-empty">{t('enquiries.boardEmpty')}</p>
            ) : groups[column.key].map((enquiry) => {
              const name = clientNames.get(enquiry.client_id) ?? enquiry.reference_number;
              const targets = boardMoveTargets(transitions, enquiry.status, role);
              const moving = movingEnquiryId === enquiry.id;

              return (
                <article className="enquiry-board-card" key={enquiry.id}>
                  <Link to={`/enquiries/${enquiry.id}`} className="enquiry-board-card-main">
                    <div className="enquiry-board-card-title">{name}</div>
                    <div className="enquiry-board-card-status">
                      <span className="badge">{label('enquiryStatus', enquiry.status)}</span>{' '}
                      {enquiry.assigned_to ? null : (
                        <span className="badge warn">{t('common.unassigned')}</span>
                      )}
                    </div>
                    <div className="enquiry-board-card-brief">
                      {enquiryBrief(enquiry)
                        || t('enquiries.projectTypeMissing')}
                    </div>
                    <div className="meta">
                      {enquiry.reference_number} · {formatDateTime(enquiry.last_action_at, language)}
                    </div>
                  </Link>

                  {targets.length > 0 ? (
                    <label className="enquiry-board-move">
                      <span className="visually-hidden">
                        {t('enquiries.boardMoveAria', { name })}
                      </span>
                      <select
                        aria-label={t('enquiries.boardMoveAria', { name })}
                        value=""
                        disabled={moving}
                        onChange={(event) => {
                          const next = event.target.value as EnquiryStatus;
                          if (next) void onMove(enquiry, next);
                        }}
                      >
                        <option value="">
                          {moving ? t('enquiries.boardMoving') : t('enquiries.boardMoveTo')}
                        </option>
                        {targets.map((target) => (
                          <option key={target} value={target}>
                            {label('enquiryStatus', target)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
