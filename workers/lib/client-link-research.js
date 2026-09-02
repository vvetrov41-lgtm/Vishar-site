import { __testing as webResearch } from './gpt-web-research.js';

const WORKER_ID = 'gpt-client-link-research';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EXCERPT_CHARS = 12000;

function enabled(env) {
  return env?.WEB_RESEARCH_ENABLED === 'true'
    && env?.WEB_RESEARCH_SCRAPE_ENABLED === 'true'
    && typeof env?.FIRECRAWL_API_KEY === 'string'
    && env.FIRECRAWL_API_KEY.trim().length >= 20
    && env?.GMAIL_SERVICE
    && typeof env.GMAIL_SERVICE.discoverClientLinkResearchEmails === 'function'
    && typeof env.GMAIL_SERVICE.claimClientLinkResearchJobs === 'function'
    && typeof env.GMAIL_SERVICE.recordClientLinkResearchResult === 'function';
}

function jobs(value) {
  return Array.isArray(value) ? value : [];
}

function safeFailure(error) {
  const reason = error instanceof Error ? error.message : '';
  return reason === 'invalid_field:url' ? 'invalid_public_url' : 'firecrawl_error';
}

async function recordFailure(env, job, errorCode) {
  await env.GMAIL_SERVICE.recordClientLinkResearchResult({
    research_id: job.research_id,
    worker_id: WORKER_ID,
    succeeded: false,
    title: null,
    markdown_excerpt: null,
    resolved_url: null,
    error_code: errorCode,
  });
}

async function processJob(env, job, fetchImpl) {
  if (!job || !UUID.test(String(job.research_id || '')) || typeof job.source_url !== 'string') {
    return { research_id: job?.research_id || null, outcome: 'invalid_job' };
  }

  try {
    const url = webResearch.normalizePublicUrl(job.source_url);
    const response = await webResearch.callFirecrawl({ kind: 'scrape', url }, env, fetchImpl);
    if (!response.ok) throw new Error('firecrawl_error');
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload.url !== 'string' || typeof payload.markdown !== 'string') {
      throw new Error('firecrawl_error');
    }
    const resolvedUrl = webResearch.normalizePublicUrl(payload.url);
    await env.GMAIL_SERVICE.recordClientLinkResearchResult({
      research_id: job.research_id,
      worker_id: WORKER_ID,
      succeeded: true,
      title: typeof payload.title === 'string' ? payload.title.slice(0, 500) : null,
      markdown_excerpt: payload.markdown.slice(0, MAX_EXCERPT_CHARS),
      resolved_url: resolvedUrl,
      error_code: null,
    });
    return { research_id: job.research_id, outcome: 'ready' };
  } catch (error) {
    const errorCode = safeFailure(error);
    try { await recordFailure(env, job, errorCode); } catch { /* lease/result state is authoritative */ }
    return { research_id: job.research_id, outcome: 'failed', error_code: errorCode };
  }
}

export async function runClientLinkResearch(env, { fetchImpl = fetch, limit = 5 } = {}) {
  if (!enabled(env)) return { skipped: true, discovered: null, processed: 0, results: [] };

  let discovered = null;
  try {
    discovered = await env.GMAIL_SERVICE.discoverClientLinkResearchEmails();
  } catch {
    discovered = { error: 'gmail_discovery_failed' };
  }

  const claimed = jobs(await env.GMAIL_SERVICE.claimClientLinkResearchJobs(
    WORKER_ID,
    Math.max(1, Math.min(Number(limit) || 5, 10)),
    180,
  ));
  const results = [];
  for (const job of claimed) results.push(await processJob(env, job, fetchImpl));

  return { skipped: false, discovered, processed: results.length, results };
}

export const __testing = Object.freeze({ enabled, safeFailure, processJob, WORKER_ID });
