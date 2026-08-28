import assert from 'node:assert/strict';
import {
  changedWorkerImportClosurePaths,
  collectWorkerImportClosure,
  localImportSpecifiers,
} from './verify-worker-import-closure.mjs';

const imports = localImportSpecifiers(`
  import { a } from './lib/a.js';
  export { b } from './lib/b.js';
  export * from './lib/c.js';
  import './lib/side-effect.js';
  const dynamic = import('./lib/dynamic.js');
  const legacy = require('./lib/legacy.js');
  import external from 'external-package';
`);
assert.deepEqual(imports, [
  './lib/a.js',
  './lib/b.js',
  './lib/c.js',
  './lib/dynamic.js',
  './lib/legacy.js',
  './lib/side-effect.js',
]);

const base = {
  'workers/telegram-drain-worker.js': "import './lib/a.js';\nimport './routes/action.js';\n",
  'workers/lib/a.js': "import './b.js';\n",
  'workers/lib/b.js': 'export const value = 1;\n',
  'workers/routes/action.js': 'export const action = true;\n',
  'workers/gmail-production.js': 'export const gmail = 1;\n',
};
const head = {
  ...base,
  'workers/gmail-production.js': 'export const gmail = 2;\n',
};
const sources = { base, head };
const readAtRef = (ref, file) => sources[ref]?.[file] ?? null;

assert.deepEqual(
  collectWorkerImportClosure('workers/telegram-drain-worker.js', (file) => base[file] ?? null),
  [
    'workers/lib/a.js',
    'workers/lib/b.js',
    'workers/routes/action.js',
    'workers/telegram-drain-worker.js',
  ],
);
assert.deepEqual(
  changedWorkerImportClosurePaths('base', 'head', 'workers/telegram-drain-worker.js', readAtRef),
  [],
  'an unrelated Gmail Worker change must not look like scheduler drift',
);

head['workers/lib/b.js'] = 'export const value = 2;\n';
assert.deepEqual(
  changedWorkerImportClosurePaths('base', 'head', 'workers/telegram-drain-worker.js', readAtRef),
  ['workers/lib/b.js'],
  'a transitive scheduler dependency change must fail closed',
);

assert.throws(
  () => collectWorkerImportClosure('workers/telegram-drain-worker.js', (file) => ({
    'workers/telegram-drain-worker.js': "import '../../outside.js';\n",
  }[file] ?? null)),
  /worker_import_outside_boundary/,
);

console.log('Worker import closure verifier tests passed.');
