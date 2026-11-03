import type { OutboxJob } from './types';

// An operator cancelling a queued delivery is a recorded disposition, not an outage.
// Keep it visible in history, while real failed/dead jobs remain actionable.
const INTENTIONAL_CANCELLATIONS = new Set([
  'operator_cancelled',
  'cancelled_by_artist_for_direct_gmail_send',
]);

export function splitDeliveryIssues(jobs: readonly OutboxJob[]): {
  actionable: OutboxJob[];
  cancelled: OutboxJob[];
} {
  const actionable: OutboxJob[] = [];
  const cancelled: OutboxJob[] = [];
  for (const job of jobs) {
    if (INTENTIONAL_CANCELLATIONS.has(job.last_error_code ?? '')) cancelled.push(job);
    else actionable.push(job);
  }
  return { actionable, cancelled };
}

export function safeDeliveryErrorCode(code: string | null): string {
  return code && /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : 'unknown_delivery_error';
}
