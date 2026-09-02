import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gateway = readFileSync(new URL('../wrangler.cloudflare-gateway.production.toml', import.meta.url), 'utf8');
const gpt = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');

assert.match(gateway, /^name = "vishar-cloudflare-gateway"$/m);
assert.match(gateway, /^main = "workers\/cloudflare-gateway\.js"$/m);
assert.match(gateway, /^workers_dev = false$/m);
assert.match(gateway, /^preview_urls = false$/m);
assert.doesNotMatch(gateway, /^routes\s*=/m, 'private gateway must not have a public route');
assert.doesNotMatch(gateway, /custom_domain\s*=\s*true/, 'private gateway must not have a custom domain');
assert.match(
  gateway,
  /\[secrets\]\s*\nrequired = \["CLOUDFLARE_API_TOKEN"\]/,
  'gateway deploy must fail closed when the required Cloudflare API token secret is missing',
);
assert.doesNotMatch(gateway, /CLOUDFLARE_API_TOKEN\s*=/, 'Cloudflare API token value must never be tracked in Wrangler config');

assert.match(
  gpt,
  /\[\[services\]\]\s*\nbinding = "CLOUDFLARE_GATEWAY"\s*\nservice = "vishar-cloudflare-gateway"/,
  'GPT production Worker must use a private Service Binding to the Cloudflare gateway',
);
for (const flag of [
  'CLOUDFLARE_CONTROL_ENABLED',
  'CLOUDFLARE_CONTROL_READ_ENABLED',
  'CLOUDFLARE_CONTROL_WRITE_ENABLED',
]) {
  assert.match(gpt, new RegExp(`^${flag} = "false"$`, 'm'), `${flag} tracked production default must remain fail-closed`);
}
assert.doesNotMatch(gpt, /CLOUDFLARE_API_TOKEN\s*=/, 'GPT Worker must never own the Cloudflare API token');

console.log('Cloudflare control production config tests passed');
