import telegramWorker from './telegram-drain-worker.js';

const MAX_AI_JOBS_PER_TICK = 3;
const AI_DRAIN_URL = 'https://tattooai.internal/internal/enquiry-ai/drain';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function assertEnquiryAiSummary(value) {
  if (!value || typeof value !== 'object') {
    throw failure('enquiry_ai_shared_drain_summary_invalid', 'invalid enquiry AI drain summary');
  }
  if (!Number.isInteger(value.processed) || value.processed < 0 || value.processed > MAX_AI_JOBS_PER_TICK) {
    throw failure('enquiry_ai_shared_drain_summary_invalid', 'invalid enquiry AI drain summary');
  }
  if (value.ok !== true) {
    const remoteCode = typeof value.errorCode === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value.errorCode)
      ? value.errorCode
      : 'enquiry_ai_shared_drain_failed';
    throw failure(remoteCode, 'enquiry AI shared drain failed');
  }
  return { processed: value.processed };
}

export async function runSharedEnquiryAiDrain(env) {
  try {
    if (!env?.TATTOOAI_SERVICE || typeof env.TATTOOAI_SERVICE.fetch !== 'function') {
      throw failure('tattooai_service_binding_unavailable', 'TattooAI service binding unavailable');
    }
    const secret = typeof env?.SUPABASE_SECRET_KEY === 'string' ? env.SUPABASE_SECRET_KEY : '';
    if (!secret) throw failure('tattooai_service_auth_unavailable', 'TattooAI service auth unavailable');
    const response = await env.TATTOOAI_SERVICE.fetch(AI_DRAIN_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response?.ok) throw failure('tattooai_service_unavailable', 'TattooAI service unavailable');
    const summary = assertEnquiryAiSummary(await response.json());
    console.log('enquiry ai shared drain', JSON.stringify(summary));
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
      ? error.code
      : 'enquiry_ai_shared_drain_error';
    console.error('enquiry ai shared drain failed', JSON.stringify({ code }));
    throw error;
  }
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

      if (!tasks.length) return;
      ctx.waitUntil(settle(tasks));
    },
  };
}

export default createProductionScheduler();

export const __testing = Object.freeze({
  AI_DRAIN_URL,
  MAX_AI_JOBS_PER_TICK,
  settle,
});
