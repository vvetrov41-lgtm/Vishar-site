import { WorkerEntrypoint } from 'cloudflare:workers';
import gmailWorker, { drainEmailOutbox } from './gmail-production.js';
import { handleGmailOperatorRequest } from './gmail-operator-api.js';

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

export default class GmailProductionEntrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const operatorResponse = await handleGmailOperatorRequest(request, this.env);
    if (operatorResponse) return operatorResponse;
    return gmailWorker.fetch(request, this.env);
  }

  async drainApprovedEmailOutbox() {
    const result = await drainEmailOutbox(this.env);
    return summarizeDrain(result);
  }
}
