import telegramWorker from './telegram-drain-worker.js';

const MAX_AI_JOBS_PER_TICK = 3;
const AI_DRAIN_URL = 'https://tattooai.internal/internal/enquiry-ai/drain';
const CRM_AGENT_DRAIN_URL = 'https://tattooai.internal/internal/crm-agent/drain';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertDrainSummary(value, invalidCode, failedCode, message) {
  if (!value || typeof value !== 'object') throw failure(invalidCode, message);
  if (!Number.isInteger(value.processed) || value.processed < 0 || value.processed > MAX_AI_JOBS_PER_TICK) {
    throw failure(invalidCode, message);
  }
  if (value.ok !== true) {
    const remoteCode = typeof value.errorCode === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value.errorCode)
      ? value.errorCode
      : failedCode;
    throw failure(remoteCode, message);
  }
  return { processed: value.processed };
}

export function assertEnquiryAiSummary(value) {
  return assertDrainSummary(
    value,
    'enquiry_ai_shared_drain_summary_invalid',
    'enquiry_ai_shared_drain_failed',
    'invalid enquiry AI drain summary',
  );
}

export function assertCrmAgentSummary(value) {
  return assertDrainSummary(
    value,
    'crm_agent_shared_drain_summary_invalid',
    'crm_agent_shared_drain_failed',
    'invalid CRM agent drain summary',
  );
}

// The Service Binding itself is the capability boundary. Do not couple two
// Workers by requiring their independent Supabase backend secrets to be
// byte-for-byte identical. The synthetic tattooai.internal host is checked by
// the callee so neither route is reachable through the public Worker URL.
async function runSharedDrain(env, { url, assert, label, errorCode }) {
  try {
    if (!env?.TATTOOAI_SERVICE || typeof env.TATTOOAI_SERVICE.fetch !== 'function') {
      throw failure('tattooai_service_binding_unavailable', 'TattooAI service binding unavailable');
    }
    const response = await env.TATTOOAI_SERVICE.fetch(url, { method: 'POST' });
    if (!response?.ok) throw failure('tattooai_service_unavailable', 'TattooAI service unavailable');
    const summary = assert(await response.json());
    console.log(label, JSON.stringify(summary));
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
      ? error.code
      : errorCode;
    console.error(`${label} failed`, JSON.stringify({ code }));
    throw error;
  }
}

export async function runSharedEnquiryAiDrain(env) {
  return runSharedDrain(env, {
    url: AI_DRAIN_URL,
    assert: assertEnquiryAiSummary,
    label: 'enquiry ai shared drain',
    errorCode: 'enquiry_ai_shared_drain_error',
  });
}

export async function runSharedCrmAgentDrain(env) {
  return runSharedDrain(env, {
    url: CRM_AGENT_DRAIN_URL,
    assert: assertCrmAgentSummary,
    label: 'crm agent shared drain',
    errorCode: 'crm_agent_shared_drain_error',
  });
}

async function settle(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

export function createProductionScheduler(baseWorker = telegramWorker) {
  return {
    fetch(request, env, ctx) {
      return baseWorker.fetch(request, env, ctx);
    },
    scheduled(controller, env, ctx) {
      const tasks = [];
      const childContext = {
        ...ctx,
        waitUntil(promise) {
          tasks.push(Promise.resolve(promise));
        },
      };

      baseWorker.scheduled(controller, env, childContext);

      if (env?.VISHAR_ENVIRONMENT === 'production'
          && env?.ENQUIRY_AI_SHARED_DRAIN_ENABLED === 'true') {
        tasks.push(runSharedEnquiryAiDrain(env));
      }

      // Independently switched. The derived-state queue can be turned on and
      // off without disturbing enquiry intake, and either failing is reported
      // on its own rather than as one opaque scheduler error.
      if (env?.VISHAR_ENVIRONMENT === 'production'
          && env?.CRM_AGENT_SHARED_DRAIN_ENABLED === 'true') {
        tasks.push(runSharedCrmAgentDrain(env));
      }

      if (!tasks.length) return;
      ctx.waitUntil(settle(tasks));
    },
  };
}

export default createProductionScheduler();

export const __testing = Object.freeze({
  AI_DRAIN_URL,
  CRM_AGENT_DRAIN_URL,
  MAX_AI_JOBS_PER_TICK,
  settle,
});
