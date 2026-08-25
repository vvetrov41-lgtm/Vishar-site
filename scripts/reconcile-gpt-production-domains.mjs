#!/usr/bin/env node

const API_ROOT = 'https://api.cloudflare.com/client/v4';

export const GPT_DOMAIN_POLICY = Object.freeze({
  worker: 'vishar-gpt-actions-production',
  coreHost: 'gpt-actions.vishartattoo.com',
  operationsHost: 'gpt-operations.vishartattoo.com',
  staleHost: 'gpt-communications.vishartattoo.com',
  zoneName: 'vishartattoo.com',
});

function fail(message) {
  throw new Error(message);
}

function listRows(result, label, nestedKey) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.[nestedKey])) return result[nestedKey];
  fail(`Cloudflare ${label} response shape is unsupported`);
}

export function classifyTargetDomains(domains, policy = GPT_DOMAIN_POLICY) {
  if (!Array.isArray(domains)) fail('Cloudflare Worker domains must be an array');

  const target = domains.filter((entry) => entry?.service === policy.worker);
  const byHostname = new Map();
  for (const entry of target) {
    const hostname = String(entry?.hostname || '');
    if (!hostname) fail('Production GPT Worker has a Custom Domain without a hostname');
    const rows = byHostname.get(hostname) || [];
    rows.push(entry);
    byHostname.set(hostname, rows);
  }

  for (const [hostname, rows] of byHostname) {
    if (rows.length !== 1) fail(`Production GPT Custom Domain is duplicated: ${hostname}`);
  }

  const canonical = [policy.coreHost, policy.operationsHost];
  for (const hostname of canonical) {
    if (!byHostname.has(hostname)) fail(`Production GPT canonical Custom Domain is missing: ${hostname}`);
  }

  const allowed = new Set([...canonical, policy.staleHost]);
  const unexpected = [...byHostname.keys()].filter((hostname) => !allowed.has(hostname)).sort();
  if (unexpected.length) {
    fail(`Unexpected Custom Domain(s) target the production GPT Worker: ${unexpected.join(', ')}`);
  }

  const stale = byHostname.get(policy.staleHost)?.[0] ?? null;
  for (const hostname of canonical) {
    const row = byHostname.get(hostname)[0];
    if (row?.zone_name !== policy.zoneName || !row?.zone_id) {
      fail(`Production GPT canonical Custom Domain has an unexpected zone: ${hostname}`);
    }
    if (row?.environment != null && row.environment !== 'production') {
      fail(`Production GPT canonical Custom Domain has an unexpected environment: ${hostname}`);
    }
  }
  if (stale) {
    if (stale?.zone_name !== policy.zoneName || !stale?.zone_id || !stale?.id) {
      fail('Stale GPT Communications Custom Domain is not safely identifiable');
    }
    if (stale?.environment != null && stale.environment !== 'production') {
      fail('Stale GPT Communications Custom Domain has an unexpected environment');
    }
  }

  return {
    targetCount: target.length,
    canonicalHosts: [...canonical].sort(),
    stale,
    requiresDetach: Boolean(stale),
  };
}

export function rollbackAttachPayload(stale, policy = GPT_DOMAIN_POLICY) {
  if (!stale?.zone_id) fail('Rollback requires the original zone_id');
  return {
    hostname: policy.staleHost,
    service: policy.worker,
    zone_id: stale.zone_id,
    zone_name: policy.zoneName,
  };
}

function deploymentSignature(result) {
  const deployments = listRows(result, 'Worker deployments', 'deployments');
  const active = deployments[0];
  if (!active?.id || !Array.isArray(active?.versions) || active.versions.length === 0) {
    fail('Production GPT Worker active deployment could not be resolved');
  }
  return JSON.stringify({
    id: active.id,
    versions: active.versions.map((version) => ({
      version_id: version?.version_id ?? null,
      percentage: version?.percentage ?? null,
    })),
  });
}

async function cloudflareRequest(accountId, token, path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.success !== true) {
    const codes = (payload?.errors || [])
      .map((entry) => Number(entry?.code))
      .filter(Number.isFinite)
      .slice(0, 5);
    fail(`Cloudflare request failed (${response.status}; codes=${codes.join(',') || 'none'}) for ${method} ${path}`);
  }
  return { status: response.status, result: payload.result ?? null };
}

async function listDomains(accountId, token) {
  const response = await cloudflareRequest(accountId, token, `/accounts/${accountId}/workers/domains?per_page=100`);
  return listRows(response.result, 'Worker domains', 'domains');
}

async function readDeploymentSignature(accountId, token, worker) {
  const response = await cloudflareRequest(
    accountId,
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/deployments`,
  );
  return deploymentSignature(response.result);
}

async function probe(url, expectedStatus) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.1' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(`Production GPT HTTP probe failed for ${new URL(url).hostname}`);
  }
  if (response.status !== expectedStatus) {
    fail(`Production GPT HTTP boundary mismatch for ${new URL(url).hostname}: expected ${expectedStatus}, got ${response.status}`);
  }
}

async function verifyCanonicalHttp(policy = GPT_DOMAIN_POLICY) {
  await Promise.all([
    probe(`https://${policy.coreHost}/privacy`, 200),
    probe(`https://${policy.coreHost}/oauth/authorize`, 400),
    probe(`https://${policy.coreHost}/v1/clients`, 401),
    probe(`https://${policy.operationsHost}/privacy`, 200),
    probe(`https://${policy.operationsHost}/v1/appointments`, 401),
  ]);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== '--apply') fail(`Unknown argument: ${arg}`);
  }
  const apply = args.has('--apply');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';

  if (!/^[0-9a-f]{32}$/.test(accountId)) fail('CLOUDFLARE_ACCOUNT_ID is missing or malformed');
  if (!token) fail('CLOUDFLARE_API_TOKEN is missing');

  const tokenState = await cloudflareRequest(accountId, token, '/user/tokens/verify');
  if (tokenState.result?.status !== 'active') fail('Cloudflare API token is not active');

  const beforeDomains = await listDomains(accountId, token);
  const before = classifyTargetDomains(beforeDomains);
  const beforeDeployment = await readDeploymentSignature(accountId, token, GPT_DOMAIN_POLICY.worker);
  await verifyCanonicalHttp();

  if (!before.requiresDetach) {
    process.stdout.write(`mode=${apply ? 'apply' : 'preflight'} mutation=not_needed canonical_domains=2\n`);
    return;
  }

  if (!apply) {
    process.stdout.write('mode=preflight mutation=required stale_domains=1 canonical_domains=2\n');
    return;
  }

  const stale = before.stale;
  let detached = false;
  try {
    await cloudflareRequest(
      accountId,
      token,
      `/accounts/${accountId}/workers/domains/${encodeURIComponent(stale.id)}`,
      { method: 'DELETE' },
    );
    detached = true;

    const afterDomains = await listDomains(accountId, token);
    const after = classifyTargetDomains(afterDomains);
    if (after.requiresDetach || after.targetCount !== 2) {
      fail('Production GPT Custom Domain set did not reconcile to the exact canonical pair');
    }

    const afterDeployment = await readDeploymentSignature(accountId, token, GPT_DOMAIN_POLICY.worker);
    if (afterDeployment !== beforeDeployment) {
      fail('Production GPT Worker deployment changed during Custom Domain reconciliation');
    }

    await verifyCanonicalHttp();
    process.stdout.write('mode=apply mutation=detached stale_domains=0 canonical_domains=2 worker_deployment_unchanged=true\n');
  } catch (error) {
    if (detached) {
      try {
        await cloudflareRequest(
          accountId,
          token,
          `/accounts/${accountId}/workers/domains`,
          { method: 'PUT', body: rollbackAttachPayload(stale) },
        );
        const rolledBack = classifyTargetDomains(await listDomains(accountId, token));
        if (!rolledBack.requiresDetach || rolledBack.targetCount !== 3) {
          fail('Rollback readback did not restore the previous GPT Custom Domain set');
        }
      } catch (rollbackError) {
        fail(`${error?.message || error}; rollback failed: ${rollbackError?.message || rollbackError}`);
      }
    }
    throw error;
  }
}

const invokedAsScript = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
