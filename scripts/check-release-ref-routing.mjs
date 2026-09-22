#!/usr/bin/env node
// Release ref routing guard (Vishar CRM audit follow-up, 2026-09-22).
//
// Specialised rollout refs (`release/private-crm-rc*-gpt-worker`,
// `-cloudflare-gateway`, `-tattooai-worker`, ...) deploy exactly one bounded
// surface through their own workflow. Two invariants keep them bounded:
//
//   1. no specialised ref may start the broad Private production release,
//      which applies migrations and deploys CRM Pages and the scheduler;
//   2. the release observer runs for exactly the refs the release runs for,
//      so it never waits for a release that was never meant to start.
//
// The check reads every workflow push filter, evaluates GitHub's branch filter
// semantics (ordered patterns, `!` negation, last match wins, `*` stops at `/`)
// and executes the real bash `case` admission guards for sample refs.
//
// Usage: node scripts/check-release-ref-routing.mjs [--self-test]

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const WORKFLOW_DIR = '.github/workflows';
const RELEASE = 'private-production-release.yml';
const OBSERVER = 'private-production-release-observer.yml';
const RELEASE_PREFIX = 'release/private-crm-rc';

// Full releases that must keep working, including names that merely contain a
// specialised word ("gmail", "calendar") without being a specialised ref.
const FULL_RELEASE_REFS = [
  'release/private-crm-rc850-audit-remediation',
  'release/private-crm-rc808-today-gmail-lazy-loading',
  'release/private-crm-rc839-shared-calendar-destination',
  'release/private-crm-rc9',
];

export function pushBranches(source) {
  const match = /\non:\n(?:[^\n]*\n)*?  push:\n    branches:\n((?:      - [^\n]+\n)+)/.exec(`\n${source}`);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^- /, '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

// GitHub evaluates branch filters in order; a later negation excludes and a
// later positive pattern re-includes.
export function filterMatches(patterns, ref) {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(ref)) included = !negated;
  }
  return included;
}

export function samplesFor(pattern) {
  return [pattern.replaceAll('*', '851'), pattern.replaceAll('*', '851-x')];
}

export function caseBlocks(source) {
  const blocks = [];
  const re = /case "\$GITHUB_REF_NAME" in\n[\s\S]*?\n\s*esac/g;
  let match;
  while ((match = re.exec(source))) blocks.push(match[0]);
  return blocks;
}

export function caseAdmits(block, ref) {
  const result = spawnSync('bash', ['-c', `${block}\nexit 0`], {
    env: { PATH: process.env.PATH, GITHUB_REF_NAME: ref },
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function check(workflows) {
  const errors = [];
  const release = workflows.get(RELEASE);
  const observer = workflows.get(OBSERVER);
  if (!release || !observer) return [`${RELEASE} and ${OBSERVER} must both exist`];

  const releaseFilter = pushBranches(release);
  const observerFilter = pushBranches(observer);
  if (JSON.stringify(releaseFilter) !== JSON.stringify(observerFilter)) {
    errors.push(`${OBSERVER} push filter must equal ${RELEASE} push filter, so the observer only waits for releases that start`);
  }

  const guarded = [
    ...caseBlocks(release).map((block, index) => [`${RELEASE} guard ${index + 1}`, block]),
    ...caseBlocks(observer).map((block, index) => [`${OBSERVER} guard ${index + 1}`, block]),
  ];
  if (caseBlocks(release).length < 1 || caseBlocks(observer).length < 1) {
    errors.push('release and observer must each keep a runtime ref admission guard');
  }

  for (const [name, source] of workflows) {
    if (name === RELEASE || name === OBSERVER) continue;
    for (const pattern of pushBranches(source)) {
      // A workflow listening on the whole namespace validates, it does not roll out.
      if (pattern.startsWith('!') || !pattern.startsWith(RELEASE_PREFIX) || pattern === `${RELEASE_PREFIX}*`) continue;
      for (const ref of samplesFor(pattern)) {
        if (filterMatches(releaseFilter, ref)) {
          errors.push(`${name}: ${ref} would also start the broad Private production release; exclude '${pattern}'`);
        }
        if (filterMatches(observerFilter, ref)) {
          errors.push(`${name}: ${ref} would start the release observer for a release that never runs`);
        }
        for (const [guardName, block] of guarded) {
          if (caseAdmits(block, ref)) errors.push(`${guardName} admits specialised ref ${ref} (${name})`);
        }
      }
    }
  }

  for (const ref of FULL_RELEASE_REFS) {
    if (!filterMatches(releaseFilter, ref)) errors.push(`${RELEASE} no longer starts for full release ref ${ref}`);
    if (!filterMatches(observerFilter, ref)) errors.push(`${OBSERVER} no longer observes full release ref ${ref}`);
    for (const [guardName, block] of guarded) {
      if (!caseAdmits(block, ref)) errors.push(`${guardName} refuses full release ref ${ref}`);
    }
  }
  return errors;
}

function loadWorkflows(dir = WORKFLOW_DIR) {
  const map = new Map();
  for (const file of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    map.set(file, readFileSync(path.join(dir, file), 'utf8'));
  }
  return map;
}

function selfTest() {
  const filter = ['release/private-crm-rc*', '!release/private-crm-rc*-gpt-worker'];
  assert.equal(filterMatches(filter, 'release/private-crm-rc850-audit'), true);
  assert.equal(filterMatches(filter, 'release/private-crm-rc850-gpt-worker'), false);
  assert.equal(filterMatches(['release/*'], 'release/a/b'), false);
  assert.equal(filterMatches(['release/**'], 'release/a/b'), true);
  assert.deepEqual(pushBranches("on:\n  push:\n    branches:\n      - 'a'\n      - '!b'\n\njobs:\n"), ['a', '!b']);

  const guard = `case "$GITHUB_REF_NAME" in\n  release/private-crm-rc*-gpt-worker) exit 1 ;;\n  release/private-crm-rc*) ;;\n  *) exit 1 ;;\nesac`;
  const wf = (branches, body = guard) => `on:\n  push:\n    branches:\n${branches.map((b) => `      - '${b}'`).join('\n')}\n\njobs:\n  x:\n    steps:\n      - run: |\n          ${body}\n`;
  const good = new Map([
    [RELEASE, wf(filter)],
    [OBSERVER, wf(filter)],
    ['gpt.yml', wf(['release/private-crm-rc*-gpt-worker'])],
  ]);
  assert.deepEqual(check(good), []);

  const leaking = new Map(good);
  leaking.set('gateway.yml', wf(['release/private-crm-rc*-cloudflare-gateway']));
  assert.ok(check(leaking).some((error) => /would also start the broad Private production release/.test(error)));

  const drift = new Map(good);
  drift.set(OBSERVER, wf(['release/private-crm-rc*']));
  assert.ok(check(drift).some((error) => /push filter must equal/.test(error)));
  console.log('Release ref routing guard self-test passed.');
}

if (process.argv[2] === '--self-test') {
  selfTest();
} else {
  const errors = check(loadWorkflows());
  if (errors.length) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log('Release ref routing OK: specialised rollout refs never start or await the broad private release.');
}
