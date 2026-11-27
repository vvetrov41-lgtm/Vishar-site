import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/machine-assembly/machine-assembly.js', import.meta.url), 'utf8');

function fixture({ query = '', reduced = false, saveData = false, webgl = true } = {}) {
  const events = new Map();
  const timers = [];
  const scripts = [];
  let probes = 0;
  const node = () => {
    const classes = new Set();
    return { classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
      dataset: {}, style: { setProperty() {} }, clientWidth: 390, clientHeight: 844, offsetHeight: 844,
      getBoundingClientRect: () => ({ top: 650, height: 844 }) };
  };
  const stage = node(), poster = node(), section = node();
  section.offsetHeight = 1800;
  section.querySelector = selector => ({ '.machine-stage': stage, '.machine-poster': poster, '.machine-canvas': node(), '.machine-skip': node() })[selector];
  const window = { location: { search: query }, scrollY: 0, innerHeight: 844, WebGLRenderingContext: webgl ? function () {} : undefined,
    matchMedia: q => ({ matches: reduced && q.includes('prefers-reduced-motion') }),
    addEventListener: (event, fn) => { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(fn); },
    removeEventListener: (event, fn) => events.get(event)?.delete(fn),
    requestIdleCallback: cb => timers.push(cb) };
  const document = { documentElement: node(), currentScript: { src: 'https://example.test/assets/machine-assembly/machine-assembly.js' },
    hidden: false, getElementById: id => id === 'machine-seq' ? section : null, addEventListener() {},
    createElement: tag => tag === 'canvas' ? { getContext() { probes++; return webgl ? {} : null; } } : {},
    head: { appendChild: el => scripts.push(el.src) } };
  vm.runInNewContext(source, { window, document, navigator: { connection: { saveData } }, URL, URLSearchParams,
    performance: { now: () => 0 }, console: { warn() {} },
    setTimeout: cb => { timers.push(cb); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const emit = event => { for (const fn of [...(events.get(event) ?? [])]) fn(); };
  return { window, document, section, poster, scripts, get probes() { return probes; }, emit,
    flushTimers() { while (timers.length) timers.shift()(); } };
}

test('initial load and idle never probe WebGL or request Three.js; poster remains available', () => {
  const f = fixture();
  f.emit('load');
  f.flushTimers();
  assert.equal(f.probes, 0);
  assert.deepEqual(f.scripts, []);
  assert.match(f.poster.src, /poster-portrait-exploded\.webp$/);
  assert.equal(f.window.__machine.mode, 'pending');
});

test('small scroll and hidden document do not start; meaningful scroll starts only once', () => {
  const f = fixture();
  f.window.scrollY = 1; f.emit('scroll');
  f.document.hidden = true; f.window.scrollY = 100; f.emit('scroll');
  assert.equal(f.probes, 0);
  f.document.hidden = false; f.emit('scroll'); f.window.scrollY = 200; f.emit('scroll');
  assert.equal(f.probes, 1);
  assert.deepEqual(f.scripts, ['/assets/vendor/three/0.128.0/three.min.js']);
});

test('reduced motion and data saver use static fallback immediately', () => {
  for (const flags of [{ reduced: true }, { saveData: true }, { query: '?static=1' }]) {
    const f = fixture(flags);
    assert.equal(f.window.__machine.mode, 'static');
    assert.equal(f.probes, 0);
    assert.deepEqual(f.scripts, []);
    assert.match(f.poster.src, /poster-portrait-assembled\.webp$/);
  }
});

test('explicit diagnostics can still start live immediately; unsupported WebGL falls back on scroll', () => {
  for (const query of ['?forceLive=1', '?s=0', '?debug=1']) {
    const f = fixture({ query });
    assert.equal(f.probes, 1);
    assert.equal(f.scripts.length, 1);
  }
  const f = fixture({ webgl: false });
  f.window.scrollY = 100; f.emit('scroll');
  assert.equal(f.window.__machine.mode, 'static');
  assert.deepEqual(f.scripts, []);
});
