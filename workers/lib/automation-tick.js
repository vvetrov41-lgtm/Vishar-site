import { createSupabaseClient } from './supabase.js';

const MAX_TICK_COUNT = 500;
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
    if (!Number.isInteger(row[field]) || row[field] < 0 || row[field] > MAX_TICK_COUNT) {
      throw invalidSummary();
    }
  }

  if (row.executed > TICK_LIMIT || row.materialised > TICK_LIMIT) throw invalidSummary();
  if (row.notified > row.executed) throw invalidSummary();

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
  return assertAutomationTickSummary(result);
}

export const __testing = {
  MAX_TICK_COUNT,
  TICK_LIMIT,
};
