#!/usr/bin/env node
// Fails unless the production GPT Worker's live custom domains are exactly the
// custom domains in wrangler.gpt-actions.production.toml.
//
// Every workflow that deploys that shared config, other than the dedicated
// domain-topology rollout, runs this before `wrangler deploy`. A deploy can
// then only ship code onto the topology it finds; it can never add or drop an
// Action domain as a side effect, bypassing the rollout's preflight, rollback
// preparation and domain readback.
//
// Read-only: one GET to the Cloudflare Workers domains API.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GPT_CONFIG_PATH = 'wrangler.gpt-actions.production.toml';

export function configCustomDomains(toml) {
  return [...toml.matchAll(/pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true/g)]
    .map((match) => match[1])
    .sort();
}

export async function liveCustomDomains({ accountId, apiToken, workerName, fetchImpl = fetch }) {
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/domains`);
  url.searchParams.set('service', workerName);
  const response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${apiToken}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !Array.isArray(payload.result)) {
    throw new Error('Could not read the production GPT Worker custom domains; refusing to deploy');
  }
  return payload.result
    .filter((row) => row?.service === workerName)
    .map((row) => row.hostname)
    .sort();
}

export function assertSameTopology(configured, live) {
  if (configured.length === 0) throw new Error('The GPT config declares no custom domains');
  if (JSON.stringify(configured) !== JSON.stringify(live)) {
    const missing = configured.filter((host) => !live.includes(host));
    const extra = live.filter((host) => !configured.includes(host));
    throw new Error(
      'This deploy would change the production GPT domain topology. Only the dedicated domain rollout may do that.'
      + (missing.length ? ` Would add: ${missing.join(', ')}.` : '')
      + (extra.length ? ` Would drop: ${extra.join(', ')}.` : ''),
    );
  }
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const workerName = process.env.GPT_TOPOLOGY_WORKER_NAME || 'vishar-gpt-actions-production';
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  const configured = configCustomDomains(fs.readFileSync(GPT_CONFIG_PATH, 'utf8'));
  const live = await liveCustomDomains({ accountId, apiToken, workerName });
  assertSameTopology(configured, live);
  console.log(`GPT domain topology unchanged: ${configured.length} custom domains match production.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
