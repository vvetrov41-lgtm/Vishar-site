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

export function cloudflareResponseAccepted({ ok, method = 'GET', payload = null } = {}) {
  if (ok !== true) return false;
  // Cloudflare Custom Domain mutation endpoints can return a successful 2xx
  // response without the standard { success: true } envelope. Mutations are
  // therefore transport-accepted here and are never considered complete until
  // a subsequent GET readback proves the requested state.
  if (method !== 'GET') return true;
  return payload?.success === true;
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

  if (!cloudflareResponseAccepted({ ok: response.ok, method, payload })) {
    const codes = (payload?.errors || [])
      .map((entry) => Number(entry?.code))
      .filter(Number.isFinite)
      .slice(0, 5);
    fail(`Cloudflare request failed (${response.status}; codes=${codes.join(',') || 'none'}) for ${method} ${path}`);
  }

  return {
    status: response.status,
    result: payload?.result ?? null,
    mutationTransportAccepted: method !== 'GET',
  };
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTargetDomainState(accountId, token, predicate, label, { attempts = 8, delayMs = 750 } = {}) {
  let lastState = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const state = classifyTargetDomains(await listDomains(accountId, token));
      lastState = state;
      lastError = null;
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) await sleep(delayMs);
  }

  if (lastError) {
    fail(`${label}: ${lastError?.message || lastError}`);
  }
  const stateText = lastState
    ? `target_count=${lastState.targetCount}, stale_present=${lastState.requiresDetach}`
    : 'state_unavailable';
  fail(`${label}: ${stateText}`);
}

async function ensurePreviousDomainState(accountId, token, stale) {
  let current = null;
  try {
    current = await waitForTargetDomainState(
      accountId,
      token,
      (state) => state.targetCount === 2 || state.targetCount === 3,
      'Rollback preflight could not resolve the GPT Custom Domain state',
      { attempts: 4, delayMs: 750 },
    );
  } catch {
    // If the control-plane read itself is temporarily unavailable, one more
    // bounded read is safer than issuing a blind attach that could duplicate
    // an already-present domain.
    current = await waitForTargetDomainState(
      accountId,
      token,
      (state) => state.targetCount === 2 || state.targetCount === 3,
      'Rollback refused because the current GPT Custom Domain state is unreadable',
      { attempts: 8, delayMs: 1000 },
    );
  }

  if (current.requiresDetach && current.targetCount === 3) {
    return 'already_restored';
  }
  if (current.requiresDetach || current.targetCount !== 2) {
    fail('Rollback refused an unexpected GPT Custom Domain state');
  }

  await cloudflareRequest(
    accountId,
    token,
    `/accounts/${accountId}/workers/domains`,
    { method: 'PUT', body: rollbackAttachPayload(stale) },
  );

  await waitForTargetDomainState(
    accountId,
    token,
    (state) => state.requiresDetach && state.targetCount === 3,
    'Rollback readback did not restore the previous GPT Custom Domain set',
  );
  return 'reattached';
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
    process.stdout.write(`mode=${apply ? 'apply' : 'preflight'} mutation=not_needed canonical_domains=2 worker_deployment_verified=true\n`);
    return;
  }

  if (!apply) {
    process.stdout.write('mode=preflight mutation=required stale_domains=1 canonical_domains=2\n');
    return;
  }

  const stale = before.stale;
  let mutationTransportAccepted = false;
  let canonicalReadbackConfirmed = false;

  try {
    await cloudflareRequest(
      accountId,
      token,
      `/accounts/${accountId}/workers/domains/${encodeURIComponent(stale.id)}`,
      { method: 'DELETE' },
    );
    mutationTransportAccepted = true;

    const after = await waitForTargetDomainState(
      accountId,
      token,
      (state) => !state.requiresDetach && state.targetCount === 2,
      'Production GPT Custom Domain DELETE was not confirmed by canonical GET readback',
    );
    if (after.requiresDetach || after.targetCount !== 2) {
      fail('Production GPT Custom Domain set did not reconcile to the exact canonical pair');
    }
    canonicalReadbackConfirmed = true;

    const afterDeployment = await readDeploymentSignature(accountId, token, GPT_DOMAIN_POLICY.worker);
    if (afterDeployment !== beforeDeployment) {
      fail('Production GPT Worker deployment changed during Custom Domain reconciliation');
    }

    await verifyCanonicalHttp();
    process.stdout.write(
      'mode=apply mutation=detached delete_transport=accepted readback=canonical stale_domains=0 canonical_domains=2 worker_deployment_unchanged=true\n',
    );
  } catch (error) {
    if (mutationTransportAccepted) {
      let rollback;
      try {
        rollback = await ensurePreviousDomainState(accountId, token, stale);
      } catch (rollbackError) {
        fail(`${error?.message || error}; rollback failed: ${rollbackError?.message || rollbackError}`);
      }
      throw new Error(`${error?.message || error}; previous domain state restored (${rollback})`);
    }
    throw error;
  }

  if (!canonicalReadbackConfirmed) {
    fail('Production GPT domain reconciliation exited without canonical GET readback');
  }
}

const invokedAsScript = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
