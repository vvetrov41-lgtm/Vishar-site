import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.cwd(), '.github/workflows');
const files = readdirSync(root)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

const forbiddenEvents = [
  ['pull_request_target', /^\s*pull_request_target\s*:/m],
  ['pull_request_review', /^\s*pull_request_review\s*:/m],
  ['workflow_run', /^\s*workflow_run\s*:/m],
];

const failures = [];

for (const name of files) {
  const path = join(root, name);
  const source = readFileSync(path, 'utf8');

  if (/^pr\d+-/i.test(basename(name))) {
    failures.push(`${name}: PR-specific one-off workflows are not permitted in the public repository`);
  }

  for (const [eventName, pattern] of forbiddenEvents) {
    if (pattern.test(source)) {
      failures.push(`${name}: forbidden privileged trigger ${eventName}`);
    }
  }
}

if (failures.length) {
  console.error('Public repository workflow safety check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public repository workflow safety check passed for ${files.length} workflow files.`);
