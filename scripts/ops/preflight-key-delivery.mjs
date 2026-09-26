// One-shot delivery of the OpenRouter key from the jev-eval environment to
// the tattooai Worker secret DECISION_MODEL_API_KEY. The two environments are
// never visible to the same job, so the key crosses between parallel jobs of
// one run sealed to an ephemeral X25519 key that never leaves the install job:
//   install: mint keypair, publish the public half as a commit status, wait
//            for the sealed artifact, open it in memory, PUT the Worker secret,
//            read back secret NAMES only, delete the artifact.
//   seal:    read the public half, seal the key (X25519 + HKDF + AES-256-GCM),
//            write sealed.json for upload.
// Nothing prints the key, its length or its prefix.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
const context = `preflight-key-delivery/${runId}/${attempt}`;
const ARTIFACT = `preflight-key-sealed-${runId}-${attempt}`;
const INFO = Buffer.from('vishar-preflight-key-v1');
const SECRET_NAME = 'DECISION_MODEL_API_KEY';
const SCRIPT = 'tattooai';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path.split('?')[0]} -> ${res.status}`);
  return res;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64 = (text) => Buffer.from(text, 'base64url');
const publicKey = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
const aesKey = (shared, epk) => Buffer.from(crypto.hkdfSync('sha256', shared, unb64(epk), INFO, 32));

async function seal() {
  const key = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (key.length < 20) throw new Error('Source key is not available in this environment.');

  let recipient = '';
  for (let i = 0; i < 60 && !recipient; i += 1) {
    const statuses = await (await gh(`repos/${repo}/commits/${sha}/statuses?per_page=100`)).json();
    recipient = statuses.find((s) => s.context === context)?.description || '';
    if (!recipient) await sleep(5000);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(recipient)) throw new Error('Recipient key was not published.');

  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'jwk' }).x;
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKey(recipient) });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(shared, epk), iv);
  const ct = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  writeFileSync('sealed.json', JSON.stringify({ epk, iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) }));
  console.log('Sealed to the published recipient.');
}

async function install() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('Cloudflare credentials are not available.');

  const me = crypto.generateKeyPairSync('x25519');
  const x = me.publicKey.export({ format: 'jwk' }).x;
  await gh(`repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({ state: 'pending', context, description: x }),
  });

  let artifact = null;
  for (let i = 0; i < 72 && !artifact; i += 1) {
    const list = await (await gh(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).json();
    artifact = (list.artifacts || []).find((a) => a.name === ARTIFACT && !a.expired) || null;
    if (!artifact) await sleep(5000);
  }
  if (!artifact) throw new Error('Sealed artifact did not arrive.');

  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const zip = Buffer.from(await (await gh(`repos/${repo}/actions/artifacts/${artifact.id}/zip`)).arrayBuffer());
  writeFileSync(join(dir, 'a.zip'), zip);
  const box = JSON.parse(execFileSync('unzip', ['-p', join(dir, 'a.zip'), 'sealed.json']).toString('utf8'));
  await gh(`repos/${repo}/actions/artifacts/${artifact.id}`, { method: 'DELETE' });

  const shared = crypto.diffieHellman({ privateKey: me.privateKey, publicKey: publicKey(box.epk) });
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(shared, box.epk), unb64(box.iv));
  decipher.setAuthTag(unb64(box.tag));
  const key = Buffer.concat([decipher.update(unb64(box.ct)), decipher.final()]).toString('utf8');
  if (key.length < 20 || /\s/.test(key)) throw new Error('Opened key failed the shape check.');

  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${SCRIPT}/secrets`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: SECRET_NAME, text: key, type: 'secret_text' }),
  });
  const putBody = await put.json().catch(() => ({}));
  if (!put.ok || putBody.success !== true) throw new Error(`Secret write failed (${put.status}).`);

  const names = ((await (await fetch(api, { headers })).json()).result || []).map((s) => s.name);
  if (!names.includes(SECRET_NAME)) throw new Error('Secret name is not visible after write.');

  await gh(`repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({ state: 'success', context, description: 'delivered' }),
  });
  console.log(`${SECRET_NAME} is present on ${SCRIPT}; sealed artifact deleted.`);
}

const mode = process.argv[2];
if (mode === 'seal') await seal();
else if (mode === 'install') await install();
else throw new Error('Usage: preflight-key-delivery.mjs seal|install');
