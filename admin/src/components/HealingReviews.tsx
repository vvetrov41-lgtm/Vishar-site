// "Healing & reviews" on Today.
//
// Two steps, both suggestions the artist acts on by pressing a button:
//  1. about four weeks after the last attended session of a block, ask the
//     client how the tattoo healed (the approved WhatsApp template);
//  2. once the client has replied, the artist reads the reply and either asks
//     for a Google review with text they can edit, or closes the card.
// Nothing is sent automatically. Every rule (which visits, the template, the
// 24-hour window, suppression, access) lives in the database; this block only
// shows what it answers and sends the artist's decision with an operation id.
// It has its own RPCs and does not change crm_private.pulse_items.

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import { OperationKeys } from '../lib/visit-outcome';
import {
  ReviewRequestError,
  type HealingSuggestion,
  type ReviewFollowup,
  type ReviewRefusal,
} from '../lib/review-requests-api';

const SNOOZE_DAYS = 14;
const REVIEW_MAX = 1000;

interface ArtistLists {
  artistId: string;
  reviewUrlConfigured: boolean;
  suggestions: HealingSuggestion[];
  followups: ReviewFollowup[];
}

type Open =
  | { kind: 'ask'; id: string }
  | { kind: 'review'; id: string; body: string }
  | null;

/** Refusals that mean the list on screen is out of date. */
const STALE: ReviewRefusal[] = ['not_suggested', 'already_decided', 'no_reply'];
const EXPLAINED: ReviewRefusal[] = [
  'not_suggested', 'already_decided', 'template_not_ready', 'no_whatsapp', 'not_reachable',
  'name_unusable', 'no_review_link', 'no_reply', 'window_closed', 'invalid',
];

export function HealingReviews({ artistIds, canDecide }: { artistIds: string[]; canDecide: boolean }) {
  const api = useApi();
  const { t, language } = useLanguage();
  const [lists, setLists] = useState<ArtistLists[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useRef(new OperationKeys());
  const scope = artistIds.join(',');

  const load = useCallback(async () => {
    const ids = scope ? scope.split(',') : [];
    const results = await Promise.all(ids.map(async (artistId): Promise<ArtistLists | 'unavailable' | 'failed'> => {
      try {
        const [suggestions, followups] = await Promise.all([
          api.listReviewSuggestions(artistId),
          // Follow-ups arrive in a later release than suggestions: until then
          // the block still shows the first step.
          api.listReviewFollowups(artistId).catch((cause: unknown) => {
            if (cause instanceof ReviewRequestError && cause.refusal === 'unavailable') return null;
            throw cause;
          }),
        ]);
        return {
          artistId,
          reviewUrlConfigured: suggestions.review_url_configured,
          suggestions: suggestions.suggestions,
          followups: followups?.items ?? [],
        };
      } catch (cause) {
        // A membership without client or conversation access, or a database
        // without these functions yet, simply has nothing to show here.
        if (cause instanceof ReviewRequestError && (cause.refusal === 'unavailable' || cause.refusal === 'permission')) {
          return 'unavailable';
        }
        return 'failed';
      }
    }));
    setLists(results.filter((row): row is ArtistLists => typeof row === 'object'));
    setLoadError(results.includes('failed'));
  }, [api, scope]);

  useEffect(() => {
    setLists(null);
    setOpen(null);
    setNotice(null);
    setError(null);
    void load();
  }, [load]);

  const suggestions = (lists ?? []).flatMap((row) => row.suggestions.map((item) => ({ artistId: row.artistId, item })));
  const followups = (lists ?? []).flatMap((row) => row.followups.map((item) => ({
    artistId: row.artistId, reviewUrlConfigured: row.reviewUrlConfigured, item,
  })));
  const count = suggestions.length + followups.filter(({ item }) => item.status === 'replied').length;

  if (!lists && !loadError) return null;
  if (suggestions.length === 0 && followups.length === 0 && !notice && !loadError) return null;

  async function act(id: string, scopeKey: unknown, run: (operationId: string) => Promise<void>, done: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await run(keys.current.keyFor(scopeKey));
      keys.current.reset();
      setOpen(null);
      setNotice(done);
      await load();
    } catch (cause) {
      const refusal = cause instanceof ReviewRequestError ? cause.refusal : 'unknown';
      if (EXPLAINED.includes(refusal)) {
        setError(t(`today.healing.refusal.${refusal}`));
        keys.current.reset();
      } else {
        // An unknown failure may have landed: the retry reuses the same
        // operation id, so the database records the decision at most once.
        setError(cause instanceof Error ? cause.message : t('today.healing.failed'));
      }
      if (STALE.includes(refusal)) {
        setOpen(null);
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card healing-reviews" id="healing-reviews" aria-labelledby="healing-reviews-title">
      <h2 id="healing-reviews-title">
        {t('today.healing.title')}{count ? ` · ${count}` : ''}
      </h2>
      <p className="meta">{t('today.healing.hint')}</p>
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
      {loadError ? (
        <p className="notice warn">
          {t('today.healing.loadFailed')}{' '}
          <button type="button" className="badge" onClick={() => { void load(); }}>{t('today.healing.retry')}</button>
        </p>
      ) : null}

      <div className="list">
        {followups.map(({ artistId, reviewUrlConfigured, item }) => {
          const id = `followup-${item.review_request_id}`;
          const editing = open?.kind === 'review' && open.id === id ? open : null;
          return (
            <div key={id} className="row healing-review-row">
              <Link to={`/clients/${item.client_id}`} className="title">{item.client_name}</Link>
              {item.status === 'replied' ? (
                <>
                  <div className="meta">
                    {item.replied_at ? t('today.healing.replied', { date: formatDate(item.replied_at, language) }) : null}
                    {item.reply_attachment_count > 0
                      ? <>{' · '}{t('today.healing.attachments', { count: item.reply_attachment_count })}</>
                      : null}
                    {item.conversation_id
                      ? <>{' · '}<Link to={`/inbox/${item.conversation_id}`}>{t('today.healing.openConversation')}</Link></>
                      : null}
                  </div>
                  {item.reply_text ? <blockquote className="healing-reply">{item.reply_text}</blockquote> : null}
                  {canDecide ? (
                    editing ? (
                      <div className="healing-review-edit">
                        <label className="meta" htmlFor={`${id}-body`}>{t('today.healing.reviewEdit')}</label>
                        <textarea
                          id={`${id}-body`}
                          value={editing.body}
                          maxLength={REVIEW_MAX}
                          onChange={(event) => setOpen({ kind: 'review', id, body: event.target.value })}
                        />
                        <div className="actions">
                          <button
                            type="button"
                            className="badge ok"
                            disabled={busy === id || editing.body.trim().length === 0}
                            onClick={() => {
                              const body = editing.body.trim();
                              void act(id, ['review', item.review_request_id, body],
                                (op) => api.askForReview(artistId, item.review_request_id, body, op),
                                t('today.healing.reviewSent', { name: item.client_name }));
                            }}
                          >
                            {t('today.healing.send')}
                          </button>
                          <button type="button" className="badge" disabled={busy === id} onClick={() => setOpen(null)}>
                            {t('today.healing.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="actions">
                        <button
                          type="button"
                          className="badge"
                          disabled={busy === id || !reviewUrlConfigured}
                          onClick={() => setOpen({ kind: 'review', id, body: item.draft_message ?? '' })}
                        >
                          {t('today.healing.askReview')}
                        </button>
                        <button
                          type="button"
                          className="badge"
                          disabled={busy === id}
                          onClick={() => {
                            void act(id, ['close', item.review_request_id],
                              (op) => api.closeReviewRequest(artistId, item.review_request_id, op),
                              t('today.healing.closed', { name: item.client_name }));
                          }}
                        >
                          {t('today.healing.close')}
                        </button>
                      </div>
                    )
                  ) : null}
                  {!reviewUrlConfigured ? <p className="meta">{t('today.healing.refusal.no_review_link')}</p> : null}
                </>
              ) : (
                <div className="meta">
                  {t('today.healing.awaiting', { date: formatDate(item.healing_asked_at, language) })}
                  {item.healing_message_status === 'failed'
                    ? <>{' · '}<span className="badge warn">{t('today.healing.notDelivered')}</span></>
                    : null}
                </div>
              )}
            </div>
          );
        })}

        {suggestions.map(({ artistId, item }) => {
          const id = `suggestion-${item.anchor_session_id}`;
          const asking = open?.kind === 'ask' && open.id === id;
          return (
            <div key={id} className="row healing-review-row">
              <Link to={`/clients/${item.client_id}`} className="title">{item.client_name}</Link>
              <div className="meta">
                {item.project_title ? <>{item.project_title}{' · '}</> : null}
                {t('today.healing.lastSession', {
                  date: formatDate(item.last_session_at, language), days: item.days_since,
                })}
              </div>
              {canDecide ? (
                asking ? (
                  <div className="healing-review-edit">
                    <p className="meta">{t('today.healing.preview')}</p>
                    <blockquote className="healing-reply">{item.draft_message}</blockquote>
                    <div className="actions">
                      <button
                        type="button"
                        className="badge ok"
                        disabled={busy === id}
                        onClick={() => {
                          void act(id, ['ask', item.anchor_session_id],
                            (op) => api.sendHealingQuestion(artistId, item.anchor_session_id, op),
                            t('today.healing.sent', { name: item.client_name }));
                        }}
                      >
                        {t('today.healing.send')}
                      </button>
                      <button type="button" className="badge" disabled={busy === id} onClick={() => setOpen(null)}>
                        {t('today.healing.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button type="button" className="badge" disabled={busy === id} onClick={() => setOpen({ kind: 'ask', id })}>
                      {t('today.healing.ask')}
                    </button>
                    <button
                      type="button"
                      className="badge"
                      disabled={busy === id}
                      onClick={() => {
                        void act(id, ['snooze', item.anchor_session_id],
                          (op) => api.decideHealingSuggestion(artistId, item.anchor_session_id, 'snooze', op, SNOOZE_DAYS),
                          t('today.healing.snoozed', { name: item.client_name }));
                      }}
                    >
                      {t('today.healing.later')}
                    </button>
                    <button
                      type="button"
                      className="badge"
                      disabled={busy === id}
                      onClick={() => {
                        void act(id, ['dismiss', item.anchor_session_id],
                          (op) => api.decideHealingSuggestion(artistId, item.anchor_session_id, 'dismiss', op),
                          t('today.healing.dismissed', { name: item.client_name }));
                      }}
                    >
                      {t('today.healing.dismiss')}
                    </button>
                  </div>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
