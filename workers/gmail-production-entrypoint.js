import { WorkerEntrypoint } from 'cloudflare:workers';
import gmailWorker, { drainEmailOutbox } from './gmail-production.js';
import { handleCompleteGmailDiscoveryRequest } from './gmail-complete-discovery-api.js';
import { handleGmailOperatorRequest } from './gmail-operator-api.js';
import { discoverGmailClientLinks } from './lib/gmail-client-link-research.js';
import { createGmailSupabase } from './lib/gmail-supabase.js';

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 20 ? value : 0;
}

function summarizeDrain(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  let sent = 0;
  let deduplicated = 0;
  let failed = 0;
  for (const row of rows) {
    if (row?.outcome === 'sent') sent += 1;
    else if (row?.outcome === 'deduplicated') deduplicated += 1;
    else if (row?.outcome === 'failed') failed += 1;
  }
  const processed = safeCount(result?.processed);
  return {
    skipped: result?.skipped === true,
    processed,
    sent: Math.min(sent, processed),
    deduplicated: Math.min(deduplicated, processed),
    failed: Math.min(failed, processed),
  };
}

function safeWorkerId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{2,127}$/.test(value) ? value : null;
}

function safeUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export default class GmailProductionEntrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const discoveryResponse = await handleCompleteGmailDiscoveryRequest(request, this.env);
    if (discoveryResponse) return discoveryResponse;
    const operatorResponse = await handleGmailOperatorRequest(request, this.env);
    if (operatorResponse) return operatorResponse;
    return gmailWorker.fetch(request, this.env);
  }

  async drainApprovedEmailOutbox() {
    const result = await drainEmailOutbox(this.env);
    return summarizeDrain(result);
  }

  async discoverClientLinkResearchEmails() {
    return discoverGmailClientLinks(this.env);
  }

  async claimClientLinkResearchJobs(workerId, limit = 5, leaseSeconds = 180) {
    const id = safeWorkerId(workerId);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
    const boundedLease = Math.max(60, Math.min(Number(leaseSeconds) || 180, 600));
    if (!id) throw new Error('client_link_research_worker_invalid');
    const db = createGmailSupabase(this.env);
    const result = await db.backendRpc('claim_client_link_research', {
      p_worker_id: id,
      p_limit: boundedLimit,
      p_lease_seconds: boundedLease,
    });
    return Array.isArray(result) ? result : [];
  }

  async recordClientLinkResearchResult(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('client_link_research_result_invalid');
    }
    const researchId = safeUuid(payload.research_id);
    const workerId = safeWorkerId(payload.worker_id);
    if (!researchId || !workerId || typeof payload.succeeded !== 'boolean') {
      throw new Error('client_link_research_result_invalid');
    }
    const db = createGmailSupabase(this.env);
    return db.backendRpc('record_client_link_research_result', {
      p_research_id: researchId,
      p_worker_id: workerId,
      p_succeeded: payload.succeeded,
      p_title: typeof payload.title === 'string' ? payload.title.slice(0, 500) : null,
      p_markdown_excerpt: typeof payload.markdown_excerpt === 'string'
        ? payload.markdown_excerpt.slice(0, 12000)
        : null,
      p_resolved_url: typeof payload.resolved_url === 'string' ? payload.resolved_url.slice(0, 2048) : null,
      p_error_code: typeof payload.error_code === 'string' ? payload.error_code.slice(0, 64) : null,
    });
  }
}
