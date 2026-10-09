#!/usr/bin/env node
// Public deploy boundary for Cloudflare Pages.
//
// Pages publishes its build output directory as-is and has no ignore file
// (only .git, node_modules and .DS_Store are skipped). With the repository
// root as the output directory, every tracked file — agent instructions,
// audits, CI workflows, Worker sources, package manifests — was public.
//
// This script copies an explicit allowlist into dist/, which is the Pages
// build output directory. Anything not listed here is not published, so a new
// file stays private until it is added deliberately. The allowlist is
// independent of sitemap.xml: the sitemap is an SEO statement, this file is a
// security boundary. A noindex page can be published by listing it here.
//
// Usage:
//   node scripts/build-public.mjs            build dist/
//   node scripts/build-public.mjs --check    build into a temp dir, verify, delete
//   node scripts/build-public.mjs --self-test  exercise the rules on a synthetic tree
//
// No dependencies (Node built-ins only), so Pages can run it with
// SKIP_DEPENDENCY_INSTALL=1.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// HTML pages, by repository path. Add a page here to publish it.
export const PUBLIC_PAGES = [
  'index.html',
  '404.html',
  'about/index.html',
  'aftercare/index.html',
  'ai-tools/index.html',
  'black-and-grey-realism-london/index.html',
  'book/index.html',
  'booking/index.html',
  'colour-realism-tattoo-london/index.html',
  'cover-up-tattoo-london/index.html',
  'faq/index.html',
  'healed-tattoos/index.html',
  'large-scale-realism-tattoo-london/index.html',
  'portrait-tattoo-artist-london/index.html',
  'privacy/index.html',
  'privacy/meta/index.html',
];

// Root-level public files and Pages configuration (_headers and _redirects are
// parsed by Pages and never served).
export const PUBLIC_ROOT_FILES = [
  '_headers',
  '_redirects',
  'components.js',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  'favicon.ico',
  'favicon.svg',
  'favicon-v4.ico',
  'favicon-v4.png',
  'favicon-black-metal.png',
  'favicon-black-metal-full.png',
  'apple-touch-icon.png',
  'apple-touch-icon-v4.png',
];

// Asset directories published recursively, restricted to web file types.
// A new directory under assets/ is not published until it is listed here.
export const PUBLIC_ASSET_DIRS = [
  'assets/black-grey',
  'assets/brand',
  'assets/colour-realism',
  'assets/cover-ups',
  'assets/css',
  'assets/gallery',
  'assets/healed',
  'assets/hero',
  'assets/js',
  'assets/machine-assembly',
  'assets/large-scale',
  'assets/og',
  'assets/portfolio',
  'assets/portraits',
  'assets/vendor',
];
const PUBLIC_ASSET_EXTENSIONS = new Set([
  '.avif', '.css', '.gif', '.ico', '.jpeg', '.jpg', '.js', '.mp4', '.png', '.svg', '.webm', '.webp', '.woff', '.woff2',
]);
// Licence texts of vendored libraries and fonts are public on purpose.
// Explicit binary model exception; arbitrary JSON or future GLB files stay private.
const PUBLIC_ASSET_FILE_NAMES = new Set(['LICENSE', 'tattoo-machine.glb']);

// Defence in depth: the build fails if any output path matches one of these,
// whatever the allowlist says. prototypes/ is never published (production or
// preview).
const FORBIDDEN_OUTPUT = [
  /(^|\/)\./, // dotfiles and dot-directories (.github, .agents, .env*, .mcp.json, …)
  /^prototypes\//,
  /^specs\//,
  /^docs\//,
  /^scripts\//,
  /^workers\//,
  /^tests\//,
  /^geo_agent\//,
  /^source-assets\//,
  /^node_modules\//,
  /\.(md|mjs|py|toml|ya?ml|lock)$/i,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)metadata\.json$/,
];

const OUT_DIR = path.join(rootDir, 'dist');

function rel(file, base = rootDir) {
  return path.relative(base, file).split(path.sep).join('/');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listAssetDir(root, dir) {
  const out = [];
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listAssetDir(root, child));
    else if (entry.isFile()
      && (PUBLIC_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || PUBLIC_ASSET_FILE_NAMES.has(entry.name))) {
      out.push(child);
    }
  }
  return out;
}

export async function collectPublicFiles(root = rootDir, allow = {}) {
  const pages = allow.pages || PUBLIC_PAGES;
  const rootFiles = allow.rootFiles || PUBLIC_ROOT_FILES;
  const assetDirs = allow.assetDirs || PUBLIC_ASSET_DIRS;
  const problems = [];
  const files = [];
  for (const file of [...pages, ...rootFiles]) {
    if (await exists(path.join(root, file))) files.push(file);
    else problems.push(`allowlisted file is missing: ${file}`);
  }
  for (const dir of assetDirs) {
    if (await exists(path.join(root, dir))) files.push(...await listAssetDir(root, dir));
    else problems.push(`allowlisted asset directory is missing: ${dir}`);
  }
  for (const file of files) {
    if (FORBIDDEN_OUTPUT.some((pattern) => pattern.test(file))) problems.push(`forbidden path in public output: ${file}`);
  }
  return { files: [...new Set(files)].sort(), problems };
}

async function copyFiles(files, outDir, root = rootDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  let bytes = 0;
  for (const file of files) {
    const target = path.join(outDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
    bytes += (await fs.stat(target)).size;
  }
  return bytes;
}

// Every root-relative reference in published HTML/CSS/JS/text must resolve
// inside the output. Values ending in "/" inside scripts are base paths that
// are concatenated at runtime (e.g. BASE = '/assets/cover-ups/'), so a
// reference is accepted when it names a directory that exists in the output.
async function verifyReferences(outDir, files) {
  const problems = [];
  const published = new Set(files);
  const resolves = (url) => {
    const clean = decodeURIComponent(url.split('#')[0].split('?')[0]);
    if (!clean.startsWith('/') || clean.startsWith('//')) return true;
    const p = clean.replace(/^\//, '');
    if (p === '') return published.has('index.html');
    if (published.has(p)) return true;
    const dir = p.endsWith('/') ? p : `${p}/`;
    if (published.has(`${dir}index.html`)) return true;
    return [...published].some((f) => f.startsWith(dir));
  };
  const patterns = [
    /(?:href|src|poster|data-src|content)="(\/[^"]*)"/g,
    /url\(\s*['"]?(\/[^)'"\s]+)/g,
    /['"`](\/(?:assets|components\.js|favicon|apple-touch)[^'"`\s]*)['"`]/g,
    /https:\/\/vishartattoo\.com(\/[^\s"'<)]*)/g,
  ];
  let checked = 0;
  for (const file of files) {
    if (!/\.(html|css|js|txt|xml)$/.test(file)) continue;
    const text = await fs.readFile(path.join(outDir, file), 'utf8');
    const refs = [];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) refs.push(match[1]);
    for (const match of text.matchAll(/srcset="([^"]*)"/g)) {
      for (const candidate of match[1].split(',')) refs.push(candidate.trim().split(/\s+/)[0]);
    }
    for (const ref of refs) {
      if (!ref || ref.includes('${')) continue;
      checked += 1;
      if (!resolves(ref)) problems.push(`${file} references ${ref}, which is not in the public output`);
    }
  }
  return { checked, problems };
}


// Synthetic repository that exercises every rule; run in CI.
async function selfTest() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'public-selftest-'));
  const out = path.join(root, 'dist');
  const write = async (file, text = 'x') => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  try {
    await write('index.html', '<a href="/about/">a</a><img src="/assets/img/a.webp"><script>const BASE = \'/assets/img/\';</script>');
    await write('about/index.html', '<link href="/components.js">');
    await write('components.js');
    await write('assets/img/a.webp');
    await write('assets/img/README.md');
    await write('assets/img/metadata.json');
    await write('assets/new-dir/b.webp');
    await write('new-page/index.html');
    await write('prototypes/demo/index.html');
    await write('AGENTS.md');
    await write('package.json', '{}');
    await write('.mcp.json', '{}');
    const allow = { pages: ['index.html', 'about/index.html'], rootFiles: ['components.js'], assetDirs: ['assets/img'] };

    const ok = await collectPublicFiles(root, allow);
    expect(ok.problems.length === 0, `clean tree reported problems: ${ok.problems.join('; ')}`);
    expect(JSON.stringify(ok.files) === JSON.stringify(['about/index.html', 'assets/img/a.webp', 'components.js', 'index.html']),
      `unexpected public set: ${ok.files.join(', ')}`);
    await copyFiles(ok.files, out, root);
    const refs = await verifyReferences(out, ok.files);
    expect(refs.problems.length === 0, `valid references reported: ${refs.problems.join('; ')}`);

    const forbidden = await collectPublicFiles(root, { ...allow, rootFiles: ['components.js', 'AGENTS.md', 'package.json', '.mcp.json'], pages: [...allow.pages, 'prototypes/demo/index.html'] });
    for (const file of ['AGENTS.md', 'package.json', '.mcp.json', 'prototypes/demo/index.html']) {
      expect(forbidden.problems.some((p) => p.includes(file)), `forbidden file was not rejected: ${file}`);
    }

    const missing = await collectPublicFiles(root, { ...allow, pages: [...allow.pages, 'gone/index.html'] });
    expect(missing.problems.some((p) => p.includes('gone/index.html')), 'missing allowlisted file was not reported');

    await write('index.html', '<a href="/new-page/">broken</a>');
    await copyFiles(ok.files, out, root);
    const broken = await verifyReferences(out, ok.files);
    expect(broken.problems.some((p) => p.includes('/new-page/')), 'reference to an unpublished page was not reported');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`build-public self-test failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('build-public self-test passed (allowlist only, new files/dirs private, forbidden paths rejected, missing files and broken references fail).');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const check = process.argv.includes('--check');
  const { files, problems } = await collectPublicFiles();
  if (problems.length) {
    console.error(`Public build failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const outDir = check ? await fs.mkdtemp(path.join(os.tmpdir(), 'public-check-')) : OUT_DIR;
  try {
    const bytes = await copyFiles(files, outDir);
    const refs = await verifyReferences(outDir, files);
    if (refs.problems.length) {
      console.error(`Public build failed (${refs.problems.length} unresolved references):\n  ${refs.problems.slice(0, 50).join('\n  ')}`);
      process.exit(1);
    }
    const pages = files.filter((f) => f.endsWith('.html')).length;
    console.log(`Public output ${check ? '(check, discarded)' : `written to ${rel(outDir)}/`}: ${files.length} files, ${pages} HTML pages, ${(bytes / 1048576).toFixed(1)} MB; ${refs.checked} local references resolved.`);
  } finally {
    if (check) await fs.rm(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}
