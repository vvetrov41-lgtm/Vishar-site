// Reconciliation of incomplete intakes.
//
// An intake can stop halfway: the Worker is evicted mid-upload, Storage returns
// a 5xx after the first of three images, or the visitor closes the tab before a
// retry. In every case the enquiry row exists and its manifests are still
// pending, which is exactly what makes recovery possible.
//
// This module decides what to do with those rows. It is deliberately a pure
// planner plus a thin executor, so the decisions are testable without a network
// or a scheduled trigger.
//
// It is NOT wired to a cron trigger in this repository. Scheduling it is a
// deployment action (docs/crm/DEPLOYMENT.md), and no Worker is deployed.

/** Uploads still in flight are left alone; only settled ones are swept. */
export const DEFAULT_GRACE_MINUTES = 15;

/** After this long a pending intake is treated as abandoned rather than slow. */
export const ABANDONED_AFTER_MINUTES = 60 * 24;

export const ACTIONS = Object.freeze({
  WAIT: 'wait',
  RESUME: 'resume',
  ABANDON: 'abandon',
});

/**
 * Decides what should happen to one incomplete intake.
 *
 * - `wait`    still inside the grace period; a request may be finishing it.
 * - `resume`  settled but recoverable: the visitor can retry with the same
 *             idempotency key, and the manifests are still there to fill.
 * - `abandon` old enough that no retry is coming. Mark it failed so it stops
 *             appearing in the reconciliation list, and let a human decide.
 *
 * Nothing here deletes an enquiry. Deleting client data is a retention
 * decision, and retention is disabled.
 */
export function planIntakeAction(intake, now = new Date(), options = {}) {
  const graceMinutes = options.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const abandonAfterMinutes = options.abandonAfterMinutes ?? ABANDONED_AFTER_MINUTES;

  const createdAt = new Date(intake.created_at);
  const ageMinutes = (now.getTime() - createdAt.getTime()) / 60000;

  if (!Number.isFinite(ageMinutes) || ageMinutes < graceMinutes) {
    return { action: ACTIONS.WAIT, enquiryId: intake.enquiry_id, ageMinutes };
  }

  if (ageMinutes >= abandonAfterMinutes) {
    return { action: ACTIONS.ABANDON, enquiryId: intake.enquiry_id, ageMinutes };
  }

  return { action: ACTIONS.RESUME, enquiryId: intake.enquiry_id, ageMinutes };
}

export function planReconciliation(intakes, now = new Date(), options = {}) {
  return (Array.isArray(intakes) ? intakes : []).map((intake) => planIntakeAction(intake, now, options));
}

/**
 * Runs a reconciliation sweep. Only `abandon` writes anything, and all it
 * writes is a failure state plus its audit event.
 */
export async function reconcileIncompleteIntakes(supabase, { logger, now = new Date(), options = {} } = {}) {
  const intakes = await supabase.rpc('list_incomplete_intakes', {
    p_older_than_minutes: options.graceMinutes ?? DEFAULT_GRACE_MINUTES,
    p_limit: options.limit ?? 50,
  });

  const plans = planReconciliation(intakes, now, options);
  const summary = { waiting: 0, resumable: 0, abandoned: 0 };

  for (const plan of plans) {
    if (plan.action === ACTIONS.WAIT) {
      summary.waiting += 1;
      continue;
    }

    if (plan.action === ACTIONS.RESUME) {
      summary.resumable += 1;
      logger?.info('reconciliation.resumable', { enquiryId: plan.enquiryId, stage: 'reconciliation' });
      continue;
    }

    summary.abandoned += 1;
    await supabase.rpc('fail_enquiry_intake', {
      p_enquiry_id: plan.enquiryId,
      p_error_code: 'intake_abandoned',
    });
    logger?.warn('reconciliation.abandoned', {
      enquiryId: plan.enquiryId,
      errorCode: 'intake_abandoned',
      stage: 'reconciliation',
    });
  }

  return summary;
}
