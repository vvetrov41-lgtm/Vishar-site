import { captureEvent } from './product-analytics';

export const TODAY_TIMING_STAGES = [
  'navigation', 'mounted', 'auth_ready', 'skeleton', 'content',
  'pulse_start', 'pulse', 'schedule_start', 'schedule',
  'navigation_start', 'navigation_data', 'supplemental_start', 'supplemental', 'gmail_start', 'gmail',
  'appointments_start', 'appointments', 'enquiries_start', 'enquiries', 'conversations_start', 'conversations',
  'email_start', 'email', 'names_start', 'names',
] as const;
export type TodayTimingStage = typeof TODAY_TIMING_STAGES[number];

let navigationAt = 0; // Cold entry includes boot and auth readiness.
export function beginTodayNavigation() { navigationAt = performance.now(); todayTiming('navigation', 0); }
export function todayNavigationStart() { return navigationAt; }
export async function todayRequest<T>(stage: 'appointments' | 'enquiries' | 'conversations' | 'email' | 'names', load: () => Promise<T>): Promise<T> {
  const start = performance.now();
  todayTiming(`${stage}_start`, 0);
  try { return await load(); }
  finally { todayTiming(stage, performance.now() - start); }
}

/** Numeric timings and fixed stage names only, never URLs, IDs, or response data. */
export function todayTiming(stage: TodayTimingStage, ms: number) {
  const normalized = stage;
  performance.mark?.(`crm_today:${normalized}`, { detail: { duration_ms: Math.round(ms) } });
  // Bounded User Timing buffer; diagnostics cannot grow for the life of the tab.
  const marks = performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith('crm_today:'));
  if (marks.length > 100) performance.clearMarks(marks[0].name);
  // Starts are available in browser diagnostics; send only completed durations
  // so telemetry itself does not double the number of network requests.
  if (stage.endsWith('_start') || stage === 'navigation' || stage === 'mounted' || stage === 'skeleton') return;
  captureEvent('crm_today_timing', { stage: normalized, duration_100ms: Math.min(365, Math.max(0, Math.round(ms / 100))) });
}
