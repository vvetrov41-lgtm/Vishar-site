// Production AI model evaluation is never an unbounded load test.
export const MAX_PRODUCTION_AI_EVAL_CALLS = 5;

export function validateProductionEvalPlan(plan, fixtureIds, explicitOnly = plan?.only) {
  if (!plan || !Array.isArray(plan.variants)) throw new Error('Missing eval variants');
  if (!Array.isArray(explicitOnly) || explicitOnly.length === 0 || new Set(explicitOnly).size !== explicitOnly.length)
    throw new Error('Explicit unique variant allow-list is mandatory');
  if (plan.repeats !== 1) throw new Error('Only one production evaluation repeat is permitted');
  if (!Number.isInteger(plan.maxCalls) || plan.maxCalls < 1 || plan.maxCalls > MAX_PRODUCTION_AI_EVAL_CALLS)
    throw new Error('Production AI eval exceeds the hard five-call limit');
  if (plan.minCallIntervalMs !== undefined && (!Number.isFinite(plan.minCallIntervalMs) || plan.minCallIntervalMs < 3_500))
    throw new Error('Production AI eval call interval cannot be shortened');
  let calls = 0;
  const variants = [];
  for (const id of explicitOnly) {
    if (typeof id !== 'string') throw new Error('Invalid variant id');
    const matches = plan.variants.filter((entry) => entry.id === id);
    if (matches.length !== 1) throw new Error('Unknown or duplicated variant');
    const entry = matches[0];
    const available = fixtureIds[entry.task];
    const fixtures = entry.fixtures ?? plan.fixtures?.[entry.task];
    if (!Array.isArray(available) || !Array.isArray(fixtures) || fixtures.length === 0
        || new Set(fixtures).size !== fixtures.length
        || !fixtures.every((fixture) => available.includes(fixture)))
      throw new Error('Unknown, empty or duplicated synthetic fixture');
    calls += fixtures.length;
    variants.push({ id, task: entry.task, fixtures: [...fixtures] });
  }
  if (calls !== plan.maxCalls || calls > MAX_PRODUCTION_AI_EVAL_CALLS)
    throw new Error('Eval selection does not fit the exact call budget');
  return Object.freeze({ calls, variants: Object.freeze(variants) });
}

/** A quota rejection is a hard stop, not a retryable test failure. */
export function classifyProductionEvalStop(firstAttempt, httpStatus) {
  if (/quota|4006|3036/i.test(String(firstAttempt?.errorDetail ?? ''))) return 'quota_exhausted';
  if (firstAttempt?.errorCode === 'provider_rate_limited' || httpStatus === 429)
    return 'provider_rate_limited';
  return null;
}
