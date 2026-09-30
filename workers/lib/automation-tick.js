import { createSupabaseClient } from './supabase.js';

const TICK_LIMIT = 100;

function invalidSummary() {
  return Object.assign(new Error('invalid automation tick summary'), {
    code: 'automation_tick_summary_invalid',
  });
}

export function assertAutomationTickSummary(value) {
  const row = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (!row || typeof row !== 'object') throw invalidSummary();

  const fields = ['materialised', 'withdrawn', 'executed', 'notified'];
  for (const field of fields) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw invalidSummary();
  }

  // Only materialisation is globally bounded by p_limit. Legacy notification
  // execution and client lifecycle execution each have their own bounded due
  // selection, while one legacy job may notify more than one current recipient.
  if (row.materialised > TICK_LIMIT) throw invalidSummary();

  return {
    materialised: row.materialised,
    withdrawn: row.withdrawn,
    executed: row.executed,
    notified: row.notified,
  };
}

export async function runAutomationTick(env, fetchImpl = fetch) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const result = await supabase.rpc('service_run_automation_tick', {
    p_limit: TICK_LIMIT,
  });
  const summary = assertAutomationTickSummary(result);

  // The heartbeat is deliberately recorded only after the scheduler result is
  // structurally valid. A failed heartbeat makes this scheduled task fail
  // closed, so CRM never receives false proof that the scheduler completed.
  await supabase.rpc('service_record_automation_scheduler_heartbeat', {});

  return summary;
}

export const __testing = {
  TICK_LIMIT,
};

export async function runLifecycleFailureAlerts(env, fetchImpl = fetch) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const created = await supabase.rpc('service_sweep_lifecycle_failure_alerts', { p_limit: 100 });
  if (!Number.isSafeInteger(created) || created < 0 || created > 100) {
    throw Object.assign(new Error('invalid lifecycle alert summary'), {
      code: 'lifecycle_alert_summary_invalid',
    });
  }
  return { created };
}

/**
 * Audit H-1: give Telegram enquiry alerts and future Calendar projections that
 * were dead-lettered by a genuine backend outage one more retry budget. The
 * database decides what is safe to replay; this returns counts only.
 */
export async function runTransientOutboxRecovery(env, fetchImpl = fetch) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const rows = await supabase.rpc('service_recover_transient_dead_outbox', { p_limit: 20 });
  const row = Array.isArray(rows) ? rows[0] : rows;
  const scanned = Number(row?.scanned);
  const recovered = Number(row?.recovered);
  if (
    !Number.isSafeInteger(scanned) || scanned < 0 || scanned > 20
    || !Number.isSafeInteger(recovered) || recovered < 0 || recovered > scanned
  ) {
    throw Object.assign(new Error('invalid outbox recovery summary'), {
      code: 'outbox_recovery_summary_invalid',
    });
  }
  return { scanned, recovered };
}

/** Audit H-5: turn dead outbox jobs and failed AI jobs into operator alerts. */
export async function runOperationalFailureAlerts(env, fetchImpl = fetch) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const created = await supabase.rpc('service_sweep_operational_failure_alerts', { p_limit: 100 });
  if (!Number.isSafeInteger(created) || created < 0 || created > 100) {
    throw Object.assign(new Error('invalid operational alert summary'), {
      code: 'operational_alert_summary_invalid',
    });
  }
  return { created };
}

/**
 * A client waiting on a reply: one reminder at 6 h and a final one at 24 h,
 * never overnight in London. The database decides what is due.
 */
export async function runUnansweredClientReminders(env, fetchImpl = fetch) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const created = await supabase.rpc('service_sweep_unanswered_client_reminders', { p_limit: 50 });
  if (!Number.isSafeInteger(created) || created < 0 || created > 50) {
    throw Object.assign(new Error('invalid unanswered reminder summary'), {
      code: 'unanswered_reminder_summary_invalid',
    });
  }
  return { created };
}
