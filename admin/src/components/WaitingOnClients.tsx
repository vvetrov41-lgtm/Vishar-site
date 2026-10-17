// Clients the studio is waiting on: the artist wrote, the client went quiet.
//
// These rows come from the server pulse (crm_private.pulse_items) and are a
// different kind of work from "Needs you now": nobody outside the studio is
// waiting, so they sit in their own block, folded, below today's schedule.
// One row per client and conversation cycle. The operator decides: open the
// conversation, "later", or "don't remind". A new message from either side
// starts a new cycle the old decision does not cover.

import { useEffect, useState } from 'react';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { useApi } from '../lib/session';
import type { AttentionItemRef } from '../lib/attention-api';
import type { TodayItem } from '../lib/today-workspace';

const DAY_MS = 86_400_000;
const LATER_CHOICES = [
  { key: 'today.silence.in3days', days: 3 },
  { key: 'today.silence.inWeek', days: 7 },
  { key: 'today.silence.inMonth', days: 30 },
] as const;

interface Decision {
  item: TodayItem;
  ref: AttentionItemRef;
  until: string | null;
}

export function WaitingOnClients({
  items,
  now,
  canDecide,
  unavailable = false,
  onChanged,
}: {
  items: TodayItem[];
  now: Date;
  canDecide: boolean;
  /** The server pulse is off or failed: the CRM cannot say who is waiting. */
  unavailable?: boolean;
  onChanged: () => void;
}) {
  const api = useApi();
  const { t, language } = useLanguage();
  const { search } = useRouter();
  const requested = search.get('waiting') === '1';
  const [open, setOpen] = useState(requested);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Decision | null>(null);

  // Statistics links here with ?waiting=1: the block opens on arrival.
  useEffect(() => {
    if (requested) setOpen(true);
  }, [requested]);

  // Arriving from Statistics while the pulse is unavailable says so, rather
  // than showing an empty block as if nobody were waiting.
  if (unavailable) {
    return requested ? (
      <section className="card waiting-on-clients" id="waiting-on-clients">
        <h2>{t('today.waitingOnClientsTitle')}</h2>
        <p className="notice warn">{t('today.silence.unavailable')}</p>
      </section>
    ) : null;
  }
  if (items.length === 0 && !last) return null;

  const oldest = items.reduce((max, item) => Math.max(max, ageDays(item, now)), 0);

  async function decide(item: TodayItem, days: number | null) {
    const ref = item.acknowledgement;
    if (!ref || busy) return;
    setBusy(item.key);
    setError(null);
    try {
      if (days === null) {
        await api.acknowledgeAttentionItem(ref);
        setLast({ item, ref, until: null });
      } else {
        const until = new Date(Date.now() + days * DAY_MS);
        await api.snoozeAttentionItem(ref, until);
        setLast({ item, ref, until: until.toISOString() });
      }
      setChoosing(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('today.silence.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!last || busy) return;
    setBusy('undo');
    setError(null);
    try {
      await api.clearAttentionAcknowledgement(last.ref);
      setLast(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('today.silence.failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card waiting-on-clients" id="waiting-on-clients" aria-labelledby="waiting-on-clients-title">
      <button
        type="button"
        className="waiting-on-clients-toggle"
        aria-expanded={open}
        aria-controls="waiting-on-clients-list"
        onClick={() => setOpen((value) => !value)}
      >
        <h2 id="waiting-on-clients-title">{t('today.waitingOnClients', { count: items.length })}</h2>
        {items.length > 0 ? (
          <span className="meta">{t('today.silence.oldest', { days: oldest })}</span>
        ) : null}
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {last ? (
        <p className="notice" role="status">
          {last.until
            ? t('today.silence.snoozed', { name: last.item.subject ?? '', date: formatDate(last.until, language) })
            : t('today.silence.dismissed', { name: last.item.subject ?? '' })}
          {' '}
          <button type="button" className="badge" disabled={busy === 'undo'} onClick={() => { void undo(); }}>
            {t('today.silence.undo')}
          </button>
        </p>
      ) : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}

      {open ? (
        <div className="list" id="waiting-on-clients-list">
          {items.map((item) => (
            <div key={item.key} className="row today-attention-row waiting-on-client-row">
              {item.href ? (
                <Link to={item.href} className="today-attention-main">
                  <RowContent item={item} now={now} />
                </Link>
              ) : (
                <div className="today-attention-main"><RowContent item={item} now={now} /></div>
              )}
              {canDecide && item.acknowledgement ? (
                choosing === item.key ? (
                  <div className="actions waiting-on-client-later" role="group" aria-label={t('today.silence.later')}>
                    {LATER_CHOICES.map((choice) => (
                      <button
                        key={choice.days}
                        type="button"
                        className="badge"
                        disabled={busy === item.key}
                        onClick={() => { void decide(item, choice.days); }}
                      >
                        {t(choice.key)}
                      </button>
                    ))}
                    <button type="button" className="badge" onClick={() => setChoosing(null)}>
                      {t('today.silence.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      className="badge"
                      disabled={busy === item.key}
                      onClick={() => setChoosing(item.key)}
                    >
                      {t('today.silence.later')}
                    </button>
                    <button
                      type="button"
                      className="badge"
                      disabled={busy === item.key}
                      onClick={() => { void decide(item, null); }}
                    >
                      {t('today.silence.dismiss')}
                    </button>
                  </div>
                )
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RowContent({ item, now }: { item: TodayItem; now: Date }) {
  const { t } = useLanguage();
  const days = ageDays(item, now);
  const channel = channelName(item.silence?.channel ?? null);
  const preview = item.silence?.preview
    ? t('today.silence.you', { text: item.silence.preview })
    : item.silence?.message_type
      ? t('today.silence.youAttachment')
      : null;
  return (
    <>
      <div className="title">{item.subject ?? t(`today.item.${item.kind}`)}</div>
      <div className="meta">
        <span className="badge">{t('today.silence.age', { days })}</span>
        {channel ? <>{' · '}{channel}</> : null}
        {item.silence?.client_reacted ? <>{' · '}{t('today.silence.clientReacted')}</> : null}
      </div>
      {preview ? <div className="meta waiting-on-client-preview">{preview}</div> : null}
    </>
  );
}

function ageDays(item: TodayItem, now: Date): number {
  if (!item.at) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(item.at).getTime()) / DAY_MS));
}

/** Channel names are product names; they are the same in both languages. */
function channelName(channel: string | null): string | null {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  if (channel === 'email') return 'Email';
  return null;
}
