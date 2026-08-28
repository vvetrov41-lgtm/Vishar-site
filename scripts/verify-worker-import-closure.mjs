import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELATIVE_SPECIFIER = /^\.\.?\//;
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMMONJS_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function localImportSpecifiers(source) {
  const found = new Set();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT, COMMONJS_REQUIRE]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (RELATIVE_SPECIFIER.test(match[1])) found.add(match[1]);
    }
  }
  return [...found].sort();
}

function candidatePaths(importer, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!base.startsWith('workers/')) throw new Error(`worker_import_outside_boundary:${base}`);
  if (path.posix.extname(base)) return [base];
  return [base, `${base}.js`, path.posix.join(base, 'index.js')];
}

function resolveLocalImport(importer, specifier, readSource) {
  const matches = candidatePaths(importer, specifier).filter((candidate) => readSource(candidate) !== null);
  if (matches.length !== 1) {
    throw new Error(`worker_import_resolution_invalid:${importer}:${specifier}`);
  }
  return matches[0];
}

export function collectWorkerImportClosure(entrypoint, readSource) {
  if (!entrypoint.startsWith('workers/')) throw new Error('worker_entrypoint_outside_boundary');
  const pending = [entrypoint];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    const source = readSource(current);
    if (source === null) throw new Error(`worker_source_missing:${current}`);
    seen.add(current);
    for (const specifier of localImportSpecifiers(source)) {
      const dependency = resolveLocalImport(current, specifier, readSource);
      if (!seen.has(dependency)) pending.push(dependency);
    }
  }
  return [...seen].sort();
}

export function changedWorkerImportClosurePaths(baseRef, headRef, entrypoint, readAtRef) {
  const baseRead = (file) => readAtRef(baseRef, file);
  const headRead = (file) => readAtRef(headRef, file);
  const union = new Set([
    ...collectWorkerImportClosure(entrypoint, baseRead),
    ...collectWorkerImportClosure(entrypoint, headRead),
  ]);
  return [...union]
    .filter((file) => baseRead(file) !== headRead(file))
    .sort();
}

export function gitSourceReader(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function assertWorkerImportClosureUnchanged(baseRef, headRef, entrypoint = 'workers/telegram-drain-worker.js') {
  const changed = changedWorkerImportClosurePaths(baseRef, headRef, entrypoint, gitSourceReader);
  if (changed.length) throw new Error(`scheduler_import_closure_changed:${changed.join(',')}`);
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [baseRef, headRef, entrypoint = 'workers/telegram-drain-worker.js'] = process.argv.slice(2);
  if (!baseRef || !headRef) throw new Error('usage: verify-worker-import-closure <base-ref> <head-ref> [entrypoint]');
  assertWorkerImportClosureUnchanged(baseRef, headRef, entrypoint);
  console.log('Worker import closure is unchanged.');
}
