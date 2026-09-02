#!/usr/bin/env node
// The Cloudflare side of splitting the CRM across two hosts.
//
// One stage per invocation, each one idempotent, each one reading back what it
// changed. The ordering constraint the split exists to protect is enforced
// here as preconditions rather than left to whoever dispatches the workflow:
//
//   * the operator host is never served without an Access application in front
//     of it, so `protect-internal` runs before the host resolves;
//   * `crm` keeps its Access application until the operator host is both
//     protected and serving the operator build, which `open-public` checks
//     before it touches anything.
//
// Nothing here prints an Access `aud`, a policy id belonging to another
// application, a token, or any Pages binding value.

const API = 'https://api.cloudflare.com/client/v4';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ZONE_NAME = process.env.CLOUDFLARE_ZONE || 'vishartattoo.com';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'crm.vishartattoo.com';
const PUBLIC_PROJECT = process.env.PUBLIC_PAGES_PROJECT || 'vishar-crm-production';
const PUBLIC_SUBDOMAIN = process.env.PUBLIC_PAGES_SUBDOMAIN || 'vishar-crm-production.pages.dev';
const INTERNAL_HOST = process.env.INTERNAL_HOST || 'app.vishartattoo.com';
const INTERNAL_PROJECT = process.env.INTERNAL_PAGES_PROJECT || 'vishar-crm-internal';
const INTERNAL_SUBDOMAIN = process.env.INTERNAL_PAGES_SUBDOMAIN || 'vishar-crm-internal.pages.dev';

/**
 * Every hostname the operator build answers on. A Pages project serves its
 * `.pages.dev` subdomain whether or not anybody asked it to, and each preview
 * deployment gets a name under it, so protecting only the custom domain leaves
 * the installation's administration surface on the open web at an address that
 * is trivial to guess. Found exactly that way: the first `deploy-internal` put
 * the operator build on `vishar-crm-internal.pages.dev` with nothing in front
 * of it.
 *
 * The public project is protected the same way - an application on its apex and
 * another on its wildcard - which is the shape being matched here.
 */
const INTERNAL_HOSTNAMES = [INTERNAL_HOST, INTERNAL_SUBDOMAIN, `*.${INTERNAL_SUBDOMAIN}`];

/**
 * Which Access scope owns a hostname. A zone-scoped token may only create an
 * application for a name inside its own zone - Cloudflare answers
 * `app and token domain mismatch` otherwise - so a `.pages.dev` name has to be
 * an account-scoped application. That is exactly how the account already holds
 * the two `vishar-crm-production.pages.dev` applications.
 */
const scopeFor = (hostname, zone) =>
  hostname === ZONE_NAME || hostname.endsWith(`.${ZONE_NAME}`)
    ? { kind: 'zones', id: zone }
    : { kind: 'accounts', id: ACCOUNT_ID };
const COMMIT = process.env.GITHUB_SHA || '';

if (!/^[0-9a-f]{32}$/.test(ACCOUNT_ID) || !TOKEN) {
  throw new Error('Cloudflare production credentials are unavailable');
}

async function api(path, { method = 'GET', body, allow = [200, 201] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!allow.includes(response.status)) {
    const errors = JSON.stringify(payload?.errors ?? payload ?? {}).slice(0, 600);
    throw new Error(`${method} ${path} -> ${response.status} ${errors}`);
  }
  return payload;
}

const list = (payload) => (Array.isArray(payload?.result) ? payload.result : []);

async function zoneId() {
  const zones = list(await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}&per_page=50`));
  const zone = zones.find((entry) => entry?.name === ZONE_NAME);
  if (!zone?.id) throw new Error(`zone ${ZONE_NAME} not found`);
  return zone.id;
}

/** Access applications are zone-scoped in this account; account scope is read
 *  too so a future move does not silently hide one. */
async function accessApps(zone) {
  const scopes = [`/zones/${zone}/access/apps?per_page=100`, `/accounts/${ACCOUNT_ID}/access/apps?per_page=100`];
  const found = [];
  for (const path of scopes) {
    const scope = path.startsWith('/zones') ? { kind: 'zones', id: zone } : { kind: 'accounts', id: ACCOUNT_ID };
    let payload;
    try { payload = await api(path); } catch (error) {
      console.log(`  (${scope.kind} scope unreadable: ${String(error.message).slice(0, 120)})`);
      continue;
    }
    for (const app of list(payload)) found.push({ scope, app });
  }
  return found;
}

async function policiesFor(scope, appId) {
  try {
    return list(await api(`/${scope.kind}/${scope.id}/access/apps/${appId}/policies?per_page=100`));
  } catch {
    return [];
  }
}

/** Everything a person needs to judge the boundary, and nothing that would
 *  help somebody forge past it. */
function safeApp(app) {
  return {
    id: app.id,
    name: app.name,
    domain: app.domain,
    type: app.type,
    session_duration: app.session_duration,
    app_launcher_visible: app.app_launcher_visible,
    allowed_idps: Array.isArray(app.allowed_idps) ? app.allowed_idps.length : 0,
    auto_redirect_to_identity: app.auto_redirect_to_identity,
  };
}

function safePolicy(policy) {
  const rules = (value) => (Array.isArray(value) ? value.map((rule) => Object.keys(rule).join('+')) : []);
  return {
    id: policy.id,
    name: policy.name,
    decision: policy.decision,
    precedence: policy.precedence,
    include: rules(policy.include),
    exclude: rules(policy.exclude),
    require: rules(policy.require),
  };
}

async function httpStatus(url) {
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'text/html' }, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') };
  } catch (error) {
    return { status: 0, location: null, error: String(error.message).slice(0, 120) };
  }
}

const isAccessGated = (probe) =>
  probe.status === 302 && String(probe.location || '').includes('/cdn-cgi/access/login/');

async function findApp(zone, host) {
  const apps = await accessApps(zone);
  return apps.find((entry) => String(entry.app?.domain || '').replace(/\/$/, '') === host) || null;
}

async function pagesProject(name) {
  try {
    return (await api(`/accounts/${ACCOUNT_ID}/pages/projects/${encodeURIComponent(name)}`))?.result ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function inspectAccess(zone) {
  const apps = await accessApps(zone);
  console.log(`Access applications visible: ${apps.length}`);
  for (const { scope, app } of apps) {
    const policies = await policiesFor(scope, app.id);
    console.log(`\n[${scope.kind}] ${JSON.stringify(safeApp(app))}`);
    for (const policy of policies) console.log(`   policy ${JSON.stringify(safePolicy(policy))}`);
  }

  console.log('\nHTTP boundaries:');
  for (const host of [PUBLIC_HOST, PUBLIC_SUBDOMAIN, INTERNAL_HOST, INTERNAL_SUBDOMAIN]) {
    const probe = await httpStatus(`https://${host}/`);
    console.log(`  ${host} -> ${probe.status}${isAccessGated(probe) ? ' (Access)' : ''}`);
  }

  const source = apps.find((entry) => entry.app?.domain === PUBLIC_HOST);
  if (!source) throw new Error(`no Access application found for ${PUBLIC_HOST}; cannot clone its policy`);
  console.log(`\nSource application for the clone: ${source.app.id} (${source.scope.kind})`);
}

async function protectInternal(zone) {
  const source = await findApp(zone, PUBLIC_HOST);
  if (!source) throw new Error(`no Access application on ${PUBLIC_HOST} to clone`);
  const sourcePolicies = await policiesFor(source.scope, source.app.id);
  if (sourcePolicies.length === 0) throw new Error(`the ${PUBLIC_HOST} application has no policy to clone`);

  for (const hostname of INTERNAL_HOSTNAMES) {
    const scope = scopeFor(hostname, zone);
    const existing = await findApp(zone, hostname);
    if (existing) {
      const policies = await policiesFor(existing.scope, existing.app.id);
      if (policies.length === 0) throw new Error(`${hostname} has an Access application with no policy`);
      console.log(`${hostname} is already protected with ${policies.length} policy(ies).`);
      continue;
    }

    const created = await api(`/${scope.kind}/${scope.id}/access/apps`, {
      method: 'POST',
      body: {
        name: `Vishar CRM operator (${hostname})`,
        domain: hostname,
        type: source.app.type || 'self_hosted',
        session_duration: source.app.session_duration || '24h',
        app_launcher_visible: false,
        auto_redirect_to_identity: source.app.auto_redirect_to_identity ?? false,
        ...(Array.isArray(source.app.allowed_idps) && source.app.allowed_idps.length
          ? { allowed_idps: source.app.allowed_idps }
          : {}),
      },
    });
    const appId = created?.result?.id;
    if (!appId) throw new Error(`Access application creation for ${hostname} returned no id`);

    for (const policy of sourcePolicies) {
      await api(`/${scope.kind}/${scope.id}/access/apps/${appId}/policies`, {
        method: 'POST',
        body: {
          name: policy.name || 'Vishar operators',
          decision: policy.decision,
          precedence: policy.precedence,
          include: policy.include ?? [],
          ...(policy.exclude?.length ? { exclude: policy.exclude } : {}),
          ...(policy.require?.length ? { require: policy.require } : {}),
        },
      });
    }
  }

  for (const hostname of INTERNAL_HOSTNAMES) {
    const readback = await findApp(zone, hostname);
    const readbackPolicies = readback ? await policiesFor(readback.scope, readback.app.id) : [];
    if (!readback || readbackPolicies.length === 0) {
      throw new Error(`${hostname} has no Access application after protect-internal`);
    }
    if (!readbackPolicies.some((policy) => policy.decision === 'allow')) {
      throw new Error(`${hostname} has no allow policy`);
    }
    console.log(`Protected ${hostname}: ${JSON.stringify(safeApp(readback.app))}`);
    for (const policy of readbackPolicies) console.log(`   policy ${JSON.stringify(safePolicy(policy))}`);
  }

  // Only the custom domain resolves before the Pages project exists; the
  // pages.dev names are checked once they serve, in verify-internal.
  const probe = await httpStatus(`https://${INTERNAL_HOST}/`);
  console.log(`${INTERNAL_HOST} answers ${probe.status}${isAccessGated(probe) ? ' (Access)' : ''}.`);
}

async function createInternalPages(zone) {
  // Protection first, always - and for every name the project will answer on,
  // not just the custom domain. A Pages custom domain starts serving within
  // seconds of being attached, and the project's own `.pages.dev` serves from
  // the first deployment whether or not anybody asked it to.
  for (const hostname of INTERNAL_HOSTNAMES) {
    if (!(await findApp(zone, hostname))) {
      throw new Error(`${hostname} has no Access application yet; run protect-internal first`);
    }
  }

  let project = await pagesProject(INTERNAL_PROJECT);
  if (!project) {
    await api(`/accounts/${ACCOUNT_ID}/pages/projects`, {
      method: 'POST',
      body: { name: INTERNAL_PROJECT, production_branch: 'production' },
    });
    project = await pagesProject(INTERNAL_PROJECT);
  }
  if (!project) throw new Error(`Pages project ${INTERNAL_PROJECT} could not be created`);
  if (project.source != null) throw new Error(`${INTERNAL_PROJECT} must remain Direct Upload`);

  const domains = list(await api(`/accounts/${ACCOUNT_ID}/pages/projects/${INTERNAL_PROJECT}/domains`));
  if (!domains.some((entry) => entry?.name === INTERNAL_HOST)) {
    await api(`/accounts/${ACCOUNT_ID}/pages/projects/${INTERNAL_PROJECT}/domains`, {
      method: 'POST',
      body: { name: INTERNAL_HOST },
    });
  }

  const records = list(await api(
    `/zones/${zone}/dns_records?name=${encodeURIComponent(INTERNAL_HOST)}&per_page=50`
  ));
  if (records.length === 0) {
    await api(`/zones/${zone}/dns_records`, {
      method: 'POST',
      body: { type: 'CNAME', name: INTERNAL_HOST, content: INTERNAL_SUBDOMAIN, proxied: true },
    });
  }

  const readbackDomains = list(await api(`/accounts/${ACCOUNT_ID}/pages/projects/${INTERNAL_PROJECT}/domains`));
  if (!readbackDomains.some((entry) => entry?.name === INTERNAL_HOST)) {
    throw new Error(`${INTERNAL_HOST} is not attached to ${INTERNAL_PROJECT}`);
  }
  console.log(`${INTERNAL_PROJECT} ready; domains: ${readbackDomains.map((entry) => entry.name).join(', ')}`);
}

async function beforeDeployInternal(zone) {
  for (const hostname of INTERNAL_HOSTNAMES) {
    if (!(await findApp(zone, hostname))) {
      throw new Error(`${hostname} has no Access application; refusing to deploy the operator build`);
    }
  }
  if (!(await pagesProject(INTERNAL_PROJECT))) throw new Error(`Pages project ${INTERNAL_PROJECT} does not exist yet`);
  console.log(`Every operator hostname is protected and ${INTERNAL_PROJECT} exists.`);
}

async function assertDeployed(project) {
  const deployments = list(await api(`/accounts/${ACCOUNT_ID}/pages/projects/${project}/deployments`));
  const match = deployments.find((entry) => (
    entry?.environment === 'production'
    && entry?.deployment_trigger?.metadata?.commit_hash === COMMIT
  ));
  if (!match) throw new Error(`exact production commit ${COMMIT.slice(0, 8)} not found in ${project} deployments`);
  console.log(`${project} is serving ${COMMIT.slice(0, 8)}.`);
}

async function afterDeployInternal(zone) {
  await assertDeployed(INTERNAL_PROJECT);
  // Both names that now serve. The subdomain is the one that caught us out.
  for (const hostname of [INTERNAL_HOST, INTERNAL_SUBDOMAIN]) {
    let gated = false;
    for (let attempt = 0; attempt < 20 && !gated; attempt += 1) {
      const probe = await httpStatus(`https://${hostname}/`);
      if (isAccessGated(probe)) {
        gated = true;
        console.log(`${hostname} answers ${probe.status} to the Access login.`);
        break;
      }
      if (probe.status === 200) throw new Error(`${hostname} is serving without Access. Stop.`);
      await new Promise((resolve) => { setTimeout(resolve, 6000); });
    }
    if (!gated) throw new Error(`${hostname} did not reach an Access-gated state`);
  }
}

async function verifyInternal(zone) {
  for (const hostname of INTERNAL_HOSTNAMES) {
    const guard = await findApp(zone, hostname);
    if (!guard) throw new Error(`${hostname} has no Access application`);
    const policies = await policiesFor(guard.scope, guard.app.id);
    if (!policies.some((policy) => policy.decision === 'allow')) {
      throw new Error(`${hostname} has no allow policy`);
    }
    console.log(`${hostname}: ${policies.length} Access policy(ies).`);
  }
  for (const hostname of [INTERNAL_HOST, INTERNAL_SUBDOMAIN]) {
    const probe = await httpStatus(`https://${hostname}/`);
    if (!isAccessGated(probe)) throw new Error(`${hostname} is not Access-gated (${probe.status})`);
  }
  const deployments = list(await api(`/accounts/${ACCOUNT_ID}/pages/projects/${INTERNAL_PROJECT}/deployments`));
  if (deployments.length === 0) throw new Error(`${INTERNAL_PROJECT} has no deployment`);
  console.log(`Operator environment: every hostname Access-gated, ${deployments.length} deployment(s).`);
  const publicProbe = await httpStatus(`https://${PUBLIC_HOST}/`);
  console.log(`${PUBLIC_HOST} still answers ${publicProbe.status}${isAccessGated(publicProbe) ? ' (Access)' : ''}.`);
}

async function beforeOpenPublic(zone) {
  // The whole ordering constraint, in one place. `crm` does not lose its
  // protection until the operator environment is protected, deployed and
  // actually answering behind Access.
  await verifyInternal(zone);
  const deployments = list(await api(`/accounts/${ACCOUNT_ID}/pages/projects/${INTERNAL_PROJECT}/deployments`));
  if (!deployments.some((entry) => entry?.environment === 'production')) {
    throw new Error(`${INTERNAL_PROJECT} has no production deployment; refusing to open ${PUBLIC_HOST}`);
  }
  console.log(`Preconditions met: ${INTERNAL_HOST} is protected and serving. Safe to open ${PUBLIC_HOST}.`);
}

async function afterOpenPublic(zone) {
  await assertDeployed(PUBLIC_PROJECT);

  // Only the custom domain loses its protection. `vishar-crm-production.pages.dev`
  // and its `*.` wildcard keep theirs deliberately: the pages.dev names are an
  // implementation detail nobody is asked to visit, the wildcard is what guards
  // preview deployments of the same build, and leaving them gated costs the
  // public CRM nothing while keeping a protected route to it for diagnosis.
  const app = await findApp(zone, PUBLIC_HOST);
  if (!app) {
    console.log(`${PUBLIC_HOST} already has no Access application.`);
  } else {
    await api(`/${app.scope.kind}/${app.scope.id}/access/apps/${app.app.id}`, {
      method: 'DELETE',
      allow: [200, 202, 204],
    });
    console.log(`Removed the Access application from ${PUBLIC_HOST}.`);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await httpStatus(`https://${PUBLIC_HOST}/`);
    if (probe.status === 200) break;
    if (attempt === 19) throw new Error(`${PUBLIC_HOST} did not become publicly reachable (${probe.status})`);
    await new Promise((resolve) => { setTimeout(resolve, 6000); });
  }

  const internalProbe = await httpStatus(`https://${INTERNAL_HOST}/`);
  if (!isAccessGated(internalProbe)) {
    throw new Error(`${INTERNAL_HOST} lost its Access protection while opening ${PUBLIC_HOST}`);
  }
  const subdomainProbe = await httpStatus(`https://${PUBLIC_SUBDOMAIN}/`);
  if (!isAccessGated(subdomainProbe)) {
    throw new Error(`${PUBLIC_SUBDOMAIN} should have kept its Access application`);
  }
  console.log(`${PUBLIC_HOST} is public; ${INTERNAL_HOST} and ${PUBLIC_SUBDOMAIN} are still Access-gated.`);
}

async function verifyPublic(zone) {
  const publicProbe = await httpStatus(`https://${PUBLIC_HOST}/`);
  if (publicProbe.status !== 200) throw new Error(`${PUBLIC_HOST} answers ${publicProbe.status}, expected 200`);
  if (await findApp(zone, PUBLIC_HOST)) throw new Error(`${PUBLIC_HOST} still has an Access application`);

  const internalProbe = await httpStatus(`https://${INTERNAL_HOST}/`);
  if (!isAccessGated(internalProbe)) throw new Error(`${INTERNAL_HOST} is not Access-gated`);
  const subdomainProbe = await httpStatus(`https://${PUBLIC_SUBDOMAIN}/`);
  if (!isAccessGated(subdomainProbe)) throw new Error(`${PUBLIC_SUBDOMAIN} is not Access-gated`);

  const body = await (await fetch(`https://${PUBLIC_HOST}/`)).text();
  if (!body.includes('noindex')) throw new Error(`${PUBLIC_HOST} did not serve the CRM document`);
  if (body.includes('VITE_CRM_SURFACE:"internal"')) {
    throw new Error(`${PUBLIC_HOST} is serving the operator surface`);
  }
  console.log(`${PUBLIC_HOST}: public, serving the CRM, not the operator surface.`);
  console.log(`${INTERNAL_HOST} and ${PUBLIC_SUBDOMAIN}: still Access-gated.`);
}

const STAGES = {
  'inspect-access': inspectAccess,
  'protect-internal': protectInternal,
  'create-internal-pages': createInternalPages,
  'deploy-internal': beforeDeployInternal,
  'deploy-internal-readback': afterDeployInternal,
  'verify-internal': verifyInternal,
  'open-public': beforeOpenPublic,
  'open-public-readback': afterOpenPublic,
  'verify-public': verifyPublic,
};

const stage = process.argv[2];
const run = STAGES[stage];
if (!run) throw new Error(`unknown stage: ${stage}`);

const zone = await zoneId();
console.log(`zone ${ZONE_NAME} (${zone}) | stage ${stage}`);
await run(zone);
