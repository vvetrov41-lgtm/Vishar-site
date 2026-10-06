#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED_ADVISORY_URL = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
// Tailwind 3 parses only the repository's own CSS at build time. Each entry is
// one advisory with no patched version inside Tailwind 3's dependency range:
// braces <=3.0.3, and postcss-selector-parser <7.1.6 (Tailwind 3 needs 6.x;
// 7.x changes the generated CSS). Exact URL and package, never a pattern.
const ALLOWED_ADVISORIES = Object.freeze([
  { url: ALLOWED_ADVISORY_URL, name: 'braces' },
  { url: 'https://github.com/advisories/GHSA-rj75-hqrm-r3gf', name: 'postcss-selector-parser' },
]);
const ALLOWED_DIRECT_ROOTS = new Set(['tailwindcss']);
const SEVERITY_RANK = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

function severityAtLeast(value, threshold) {
  const rank = SEVERITY_RANK.get(String(value || '').toLowerCase());
  const minimum = SEVERITY_RANK.get(String(threshold || '').toLowerCase());
  if (rank == null || minimum == null) return true;
  return rank >= minimum;
}

function isAllowedAdvisory(via) {
  if (!via || typeof via !== 'object') return false;
  const url = String(via.url || '').toLowerCase();
  const name = String(via.name || via.dependency || '').toLowerCase();
  return ALLOWED_ADVISORIES.some((allowed) => url === allowed.url.toLowerCase() && name === allowed.name);
}

export function evaluateAudit(report, packageJson, threshold = 'moderate') {
  if (!report || report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    return { ok: false, blocked: ['invalid_audit_report'], allowed: [] };
  }

  const vulnerabilities = report.vulnerabilities || {};
  const memo = new Map();
  const visiting = new Set();

  function isAllowedEntry(name) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return false;

    const entry = vulnerabilities[name];
    if (!entry || !Array.isArray(entry.via) || entry.via.length === 0) {
      memo.set(name, false);
      return false;
    }

    if (entry.isDirect) {
      const isAllowedRoot = ALLOWED_DIRECT_ROOTS.has(name);
      const isDevDependency = Object.prototype.hasOwnProperty.call(packageJson.devDependencies || {}, name);
      const isRuntimeDependency = Object.prototype.hasOwnProperty.call(packageJson.dependencies || {}, name)
        || Object.prototype.hasOwnProperty.call(packageJson.optionalDependencies || {}, name);
      if (!isAllowedRoot || !isDevDependency || isRuntimeDependency) {
        memo.set(name, false);
        return false;
      }
    }

    visiting.add(name);
    const allowed = entry.via.every((cause) => {
      if (typeof cause === 'string') return isAllowedEntry(cause);
      return isAllowedAdvisory(cause);
    });
    visiting.delete(name);
    memo.set(name, allowed);
    return allowed;
  }

  const relevant = Object.entries(vulnerabilities)
    .filter(([, value]) => severityAtLeast(value?.severity, threshold))
    .map(([name]) => name);

  const allowed = relevant.filter((name) => isAllowedEntry(name));
  const blocked = relevant.filter((name) => !isAllowedEntry(name));
  return { ok: blocked.length === 0, blocked, allowed };
}

function runSelfTest() {
  const advisory = {
    source: 999,
    name: 'braces',
    dependency: 'braces',
    title: 'stack exhaustion',
    url: ALLOWED_ADVISORY_URL,
    severity: 'high',
    range: '<=3.0.3',
  };
  const allowedReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: { name: 'braces', severity: 'high', isDirect: false, via: [advisory] },
      chokidar: { name: 'chokidar', severity: 'high', isDirect: false, via: ['braces'] },
      micromatch: { name: 'micromatch', severity: 'high', isDirect: false, via: ['braces'] },
      'fast-glob': { name: 'fast-glob', severity: 'high', isDirect: false, via: ['micromatch'] },
      tailwindcss: { name: 'tailwindcss', severity: 'high', isDirect: true, via: ['chokidar', 'fast-glob', 'micromatch'] },
    },
  };
  const packageJson = { devDependencies: { tailwindcss: '^3.4.17' } };
  assert.equal(evaluateAudit(allowedReport, packageJson).ok, true, 'the exact Tailwind dev-only chain is allowed');

  const unrelated = structuredClone(allowedReport);
  unrelated.vulnerabilities.braces.via.push({
    ...advisory,
    source: 1000,
    url: 'https://github.com/advisories/GHSA-not-allowed',
  });
  assert.equal(evaluateAudit(unrelated, packageJson).ok, false, 'any additional advisory fails closed');

  const runtimeRoot = { dependencies: { tailwindcss: '^3.4.17' }, devDependencies: { tailwindcss: '^3.4.17' } };
  assert.equal(evaluateAudit(allowedReport, runtimeRoot).ok, false, 'the exception is not valid for a runtime dependency');

  const mixed = structuredClone(allowedReport);
  mixed.vulnerabilities.someRuntimePackage = {
    name: 'someRuntimePackage',
    severity: 'moderate',
    isDirect: true,
    via: [{ source: 1001, name: 'someRuntimePackage', url: 'https://github.com/advisories/GHSA-other', severity: 'moderate' }],
  };
  assert.equal(evaluateAudit(mixed, packageJson).ok, false, 'a second vulnerability still blocks CI');

  const selectorParser = {
    source: 1002,
    name: 'postcss-selector-parser',
    dependency: 'postcss-selector-parser',
    url: 'https://github.com/advisories/GHSA-rj75-hqrm-r3gf',
    severity: 'moderate',
    range: '<7.1.6',
  };
  const withSelectorParser = structuredClone(allowedReport);
  withSelectorParser.vulnerabilities['postcss-selector-parser'] = { name: 'postcss-selector-parser', severity: 'moderate', isDirect: false, via: [selectorParser] };
  withSelectorParser.vulnerabilities['postcss-nested'] = { name: 'postcss-nested', severity: 'moderate', isDirect: false, via: ['postcss-selector-parser'] };
  withSelectorParser.vulnerabilities.tailwindcss.via.push('postcss-nested', 'postcss-selector-parser');
  assert.equal(evaluateAudit(withSelectorParser, packageJson).ok, true, 'the selector parser advisory through Tailwind 3 is allowed');

  const swapped = structuredClone(withSelectorParser);
  swapped.vulnerabilities['postcss-selector-parser'].via = [{ ...selectorParser, name: 'braces' }];
  assert.equal(evaluateAudit(swapped, packageJson).ok, false, 'an advisory is allowed only for its own package');

  console.log('npm audit allowlist self-test passed');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const auditLevelArg = args.find((arg) => arg.startsWith('--audit-level='));
  const auditLevel = auditLevelArg?.split('=')[1] || 'moderate';
  if (!SEVERITY_RANK.has(auditLevel)) {
    console.error(`Unsupported audit level: ${auditLevel}`);
    process.exit(2);
  }

  const result = spawnSync('npm', ['audit', '--json', `--audit-level=${auditLevel}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    console.error(`npm audit could not run: ${result.error.message}`);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(result.stdout || '');
  } catch {
    console.error('npm audit did not return valid JSON. Refusing to bypass the audit.');
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(2);
  }

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const evaluation = evaluateAudit(report, packageJson, auditLevel);

  if (!evaluation.ok) {
    console.error(`npm audit blocked CI. Unapproved ${auditLevel}+ vulnerabilities: ${evaluation.blocked.join(', ')}`);
    process.exit(1);
  }

  if (evaluation.allowed.length > 0) {
    console.warn(
      `npm audit found only the approved dev-build advisories ${ALLOWED_ADVISORIES.map((a) => a.url).join(', ')} `
      + `through Tailwind 3 (${evaluation.allowed.join(', ')}). No patched version fits Tailwind 3 yet; CI remains fail-closed for every other advisory.`,
    );
  } else {
    console.log(`npm audit: no ${auditLevel}+ vulnerabilities`);
  }
}

main();
