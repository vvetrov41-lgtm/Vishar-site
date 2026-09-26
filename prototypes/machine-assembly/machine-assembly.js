/* Homepage machine assembly sequence — isolated prototype.
 * specs/homepage-machine-assembly/ (spec.md FR-001…FR-012).
 *
 * Runs on the vendored Three.js r128 global build. Nothing 3D is requested
 * during initial page load: libraries, timeline and model load on the first
 * scroll or when the page is idle after `load`. Frames are rendered only while
 * the damped scroll value moves, and never while the section is out of view.
 *
 * Scroll value s ∈ [-1, 1]:
 *   s ∈ [-1, 0)  entry: the stage is still rising inside the hero's gradient
 *   s ∈ [0, 1]   progress p of the sticky sequence (timeline.js)
 *
 * Query flags (prototype only): ?debug=1, ?s=<-1..1>, ?layout=landscape|portrait,
 * ?static=1 (force the static fallback).
 */
(function () {
  'use strict';

  var section = document.getElementById('machine-seq');
  if (!section) return;
  var portfolio = document.getElementById('portfolio');
  var stage = section.querySelector('.machine-stage');
  var canvasHost = section.querySelector('.machine-canvas');
  var poster = section.querySelector('.machine-poster');
  var docEl = document.documentElement;

  var base = new URL('.', document.currentScript.src).href;
  var ASSETS = {
    three: '/assets/vendor/three/0.128.0/three.min.js',
    loader: base + 'lib/GLTFLoader.js',
    room: base + 'lib/RoomEnvironment.js',
    timeline: base + 'timeline.js',
    model: base + 'assets/tattoo-machine.glb'
  };
  function posterUrl(layout, state) { return base + 'assets/poster-' + layout + '-' + state + '.webp'; }

  var params = new URLSearchParams(window.location.search);
  var DEBUG = params.has('debug');
  var FORCED_S = params.has('s') ? clamp(parseFloat(params.get('s')), -1, 1) : null;
  var FORCED_LAYOUT = params.get('layout');
  var FORCE_STATIC = params.has('static');
  var FORCE_LIVE = params.has('forceLive');
  var DIAG = params.has('diag');
  var staticReason = '';

  // Keep the scroll response cinematic on touch devices. The previous 120 ms
  // damping plus a 0.5 progress snap could skip most of the assembly in one
  // inertial swipe. 650 ms is intentionally close to the old GSAP scrub feel.
  var DAMPING_SECONDS = 0.65;

  // ── Small math helpers ──────────────────────────────────────────────────
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeInOutCubic(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  // ── Capability gates (same heuristics as the production homepage) ───────
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function isWeakDevice() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')) return true;
    var mobile = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
    if (!mobile) return false;
    if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 2) return true;
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2) return true;
    return false;
  }
  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  function currentLayout() {
    if (FORCED_LAYOUT === 'portrait' || FORCED_LAYOUT === 'landscape') return FORCED_LAYOUT;
    return stage.clientWidth / Math.max(1, stage.clientHeight) < 0.9 ? 'portrait' : 'landscape';
  }

  function showPoster(state) {
    poster.onerror = function () { poster.classList.remove('is-shown'); };
    poster.onload = function () { poster.classList.add('is-shown'); };
    poster.src = posterUrl(currentLayout(), state);
  }

  // Static fallback: reduced motion, no WebGL, weak device, load or GPU failure.
  function enterStaticMode(reason) {
    staticReason = reason || 'unknown';
    if (reason) console.warn('[machine] static mode: ' + reason);
    stopLoop();
    section.classList.remove('is-live');
    section.classList.add('is-static');
    docEl.classList.add('machine-static');
    showPoster('assembled');
    if (window.__machine) {
      window.__machine.mode = 'static';
      window.__machine.staticReason = staticReason;
    }
    updateDiagnostic();
  }

  // ── Scroll metrics ──────────────────────────────────────────────────────
  var metrics = { top: 0, distance: 1 };
  function measure() {
    var rect = section.getBoundingClientRect();
    metrics.top = rect.top + window.scrollY;
    metrics.distance = Math.max(1, section.offsetHeight - stage.offsetHeight);
  }
  function scrollValue() {
    var y = window.scrollY;
    if (y < metrics.top) return metrics.top > 0 ? clamp(y / metrics.top, 0, 1) - 1 : 0;
    return clamp((y - metrics.top) / metrics.distance, 0, 1);
  }
  function updateCssState(s) {
    var e = clamp(s + 1, 0, 1);
    var p = clamp(s, 0, 1);
    section.style.setProperty('--entry-shade', (1 - smooth(e / 0.85)).toFixed(3));
    section.style.setProperty('--skip-opacity', (p > 0.02 && p < 0.9 ? 1 : 0).toString());
    section.style.setProperty('--glow', ((1 - smooth((p - 0.86) / 0.1)) * smooth(e / 0.9)).toFixed(3));
  }

  // ── Script loading ──────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = false;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('Unable to load ' + src)); };
      document.head.appendChild(el);
    });
  }
  function loadLibraries() {
    var chain = window.THREE ? Promise.resolve() : loadScript(ASSETS.three);
    return chain
      .then(function () { return Promise.all([loadScript(ASSETS.loader), loadScript(ASSETS.room), loadScript(ASSETS.timeline)]); });
  }

  // ── Scene ───────────────────────────────────────────────────────────────
  var THREE_ = null;
  var renderer, scene, camera, machineRoot, keyLight, rimLight;
  var groups = []; // { node, spec, rest, axis, materials[] }
  var timeline = null;
  var layout = 'landscape';
  var tmpV = null, tmpQ = null, tmpAxis = null;

  function buildScene(gltf) {
    THREE_ = window.THREE;
    tmpV = new THREE_.Vector3(); tmpQ = new THREE_.Quaternion(); tmpAxis = new THREE_.Vector3();
    var mobile = window.matchMedia('(max-width: 767px)').matches;

    renderer = new THREE_.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 2 : 1.75));
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE_.sRGBEncoding;
    renderer.toneMapping = THREE_.ACESFilmicToneMapping;
    renderer.physicallyCorrectLights = true;
    canvasHost.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      enterStaticMode('WebGL context lost');
    });

    scene = new THREE_.Scene();
    var pmrem = new THREE_.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new THREE_.RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    keyLight = new THREE_.DirectionalLight(0xffe3c8, 2.4);
    rimLight = new THREE_.DirectionalLight(0xc4d4ff, 2.2);
    rimLight.position.set(0.55, 0.4, -0.75);
    scene.add(keyLight, rimLight);

    camera = new THREE_.PerspectiveCamera(30, stage.clientWidth / stage.clientHeight, 0.003, 5);

    machineRoot = gltf.scene.getObjectByName('Tattoo_mach');
    scene.add(gltf.scene);

    var sharedMaterial = null;
    machineRoot.children.forEach(function (node) {
      var spec = timeline.groups[node.name];
      if (!spec) throw new Error('No timeline entry for ' + node.name);
      var extras = node.userData || {};
      var entry = {
        node: node,
        spec: spec,
        rest: node.position.clone(),
        axis: new THREE_.Vector3().fromArray(extras.axis || [0, 1, 0]).normalize(),
        materials: []
      };
      node.traverse(function (o) {
        if (!o.isMesh) return;
        sharedMaterial = sharedMaterial || o.material;
        if (spec.fade) {
          o.material = o.material.clone();
          entry.materials.push(o.material);
        }
      });
      groups.push(entry);
    });
    if (groups.length !== 18) throw new Error('Expected 18 groups, found ' + groups.length);
    groups.forEach(function (g) {
      g.node.traverse(function (o) { if (o.isMesh) o.material.envMapIntensity = 1.0; });
    });

    if (DEBUG) addPivotHelpers();
    resizeRenderer(true);
  }

  // ── Timeline evaluation ─────────────────────────────────────────────────
  // Offset along the polyline offset → via → seat, parameterised by arc length.
  // k = 1 is the exploded end, k = 0 the seat.
  function pathOffset(offset, via, k) {
    if (!via) return [offset[0] * k, offset[1] * k, offset[2] * k];
    var first = Math.hypot(offset[0] - via[0], offset[1] - via[1], offset[2] - via[2]);
    var second = Math.hypot(via[0], via[1], via[2]);
    var along = k * (first + second); // distance from the seat
    if (along <= second) {
      var f = second > 0 ? along / second : 0;
      return [via[0] * f, via[1] * f, via[2] * f];
    }
    var g = (along - second) / first;
    return [lerp(via[0], offset[0], g), lerp(via[1], offset[1], g), lerp(via[2], offset[2], g)];
  }

  function applyGroups(p) {
    groups.forEach(function (g) {
      var spec = g.spec;
      var t = clamp((p - spec.window[0]) / (spec.window[1] - spec.window[0]), 0, 1);
      var k = 1 - easeInOutCubic(t); // 1 = exploded, 0 = seated
      var node = g.node;

      node.position.copy(g.rest);
      if (spec.along === 'axis') {
        node.position.addScaledVector(g.axis, spec.offset[layout] * k);
      } else if (spec.offset) {
        var o = pathOffset(spec.offset[layout], spec.via && spec.via[layout], k);
        node.position.x += o[0]; node.position.y += o[1]; node.position.z += o[2];
      }

      node.quaternion.identity();
      if (spec.rot) {
        tmpAxis.fromArray(spec.rot.axis === 'axis' ? g.axis.toArray() : spec.rot.axis).normalize();
        node.quaternion.setFromAxisAngle(tmpAxis, spec.rot.angle * k);
      }
      if (spec.turns) {
        // Threads engage only in the last `threadShare` of the move.
        var share = spec.threadShare || 0.5;
        var thread = clamp((t - (1 - share)) / share, 0, 1);
        tmpQ.setFromAxisAngle(g.axis, spec.turns * Math.PI * 2 * (1 - smooth(thread)));
        node.quaternion.multiply(tmpQ);
      }
      var scale = spec.scale ? lerp(1, spec.scale, k) : 1;
      node.scale.setScalar(scale);

      if (spec.fade) {
        var opacity = 1 - k;
        node.visible = opacity > 0.002;
        g.materials.forEach(function (m) {
          var transparent = opacity < 0.999;
          if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
          m.opacity = opacity;
          m.depthWrite = !transparent || opacity > 0.6;
        });
      }
    });
  }

  function keyPosition(key) {
    if (key.pos) return key.pos;
    var d = key.dir, len = Math.hypot(d[0], d[1], d[2]);
    return [key.target[0] + d[0] / len * key.dist, key.target[1] + d[1] / len * key.dist, key.target[2] + d[2] / len * key.dist];
  }
  function sampleKeys(keys, p, read) {
    var i = 0;
    while (i < keys.length - 2 && p > keys[i + 1].p) i += 1;
    var a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(keys.length - 1, i + 2)];
    var t = clamp((p - b.p) / (c.p - b.p), 0, 1);
    var va = read(a), vb = read(b), vc = read(c), vd = read(d);
    return vb.map(function (_, n) { return catmull(va[n], vb[n], vc[n], vd[n], t); });
  }
  function sampleLinear(keys, p, field) {
    var i = 0;
    while (i < keys.length - 2 && p > keys[i + 1].p) i += 1;
    var b = keys[i], c = keys[i + 1];
    return lerp(b[field], c[field], smooth((p - b.p) / (c.p - b.p)));
  }

  // Keys marked `fit` get target and distance solved so that every group, in its
  // pose at that progress, fits the safe area of the current viewport (below
  // the fixed nav). This keeps the composition stable across aspect ratios.
  var fittedKeys = {};
  function fitCameraKeys() {
    var keys = timeline.camera[layout];
    var navPx = 64;
    var h = stage.clientHeight || 1;
    fittedKeys[layout] = keys.map(function (key) {
      if (!key.fit) return key;
      applyGroups(key.p);
      machineRoot.position.set(0, 0, 0);
      machineRoot.rotation.set(0, 0, 0);
      machineRoot.updateMatrixWorld(true);
      var points = [];
      var box = new THREE_.Box3();
      groups.forEach(function (g) {
        box.setFromObject(g.node);
        for (var i = 0; i < 8; i += 1) {
          points.push(new THREE_.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
        }
      });
      var margin = key.fit;
      var top = 1 - 2 * (navPx / h + margin.top), bottom = -1 + 2 * margin.bottom;
      var side = 1 - 2 * margin.side;
      var dir = new THREE_.Vector3().fromArray(key.dir).normalize();
      var target = new THREE_.Vector3().fromArray(key.target);
      var dist = key.dist;
      var cam = new THREE_.PerspectiveCamera(key.fov, camera.aspect, 0.003, 5);
      var right = new THREE_.Vector3(), up = new THREE_.Vector3(), v = new THREE_.Vector3();
      for (var iter = 0; iter < 6; iter += 1) {
        cam.position.copy(target).addScaledVector(dir, dist);
        cam.lookAt(target);
        cam.updateMatrixWorld(true);
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        points.forEach(function (pt) {
          v.copy(pt).project(cam);
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        });
        var scale = Math.max((maxX - minX) / (2 * side), (maxY - minY) / (top - bottom));
        var halfH = dist * Math.tan(key.fov * Math.PI / 360);
        right.setFromMatrixColumn(cam.matrixWorld, 0);
        up.setFromMatrixColumn(cam.matrixWorld, 1);
        target.addScaledVector(right, (minX + maxX) / 2 * halfH * cam.aspect);
        target.addScaledVector(up, ((minY + maxY) / 2 - (top + bottom) / 2) * halfH);
        dist *= scale;
      }
      return Object.assign({}, key, { target: target.toArray(), dist: dist });
    });
  }

  function applyCamera(p, e) {
    var keys = fittedKeys[layout] || timeline.camera[layout];
    var pos = sampleKeys(keys, p, keyPosition);
    var target = sampleKeys(keys, p, function (k) { return k.target; });
    camera.position.fromArray(pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(target[0], target[1], target[2]);
    camera.rotateZ(sampleLinear(keys, p, 'roll'));
    var fov = sampleLinear(keys, p, 'fov');
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }

    // Entry: the whole machine rises out of the hero gradient.
    var rise = 1 - smooth(e);
    machineRoot.position.set(0, -0.06 * rise, 0);
    machineRoot.rotation.set(0, 0.22 * rise, 0);
  }

  function applyLight(p) {
    var keys = timeline.light;
    renderer.toneMappingExposure = sampleLinear(keys, p, 'exposure');
    var az = sampleLinear(keys, p, 'keyAzimuth');
    keyLight.intensity = sampleLinear(keys, p, 'key');
    rimLight.intensity = sampleLinear(keys, p, 'rim');
    var x = -0.45, z = 0.55; // base key direction, rotated about Y
    keyLight.position.set(x * Math.cos(az) + z * Math.sin(az), 0.75, -x * Math.sin(az) + z * Math.cos(az));
  }

  function stageAt(p) {
    var name = '';
    timeline.stages.forEach(function (st) { if (p >= st.from && p <= st.to) name = st.id + ' · ' + st.name; });
    return name;
  }

  // ── Render loop (on demand) ─────────────────────────────────────────────
  var state = { target: 0, current: null, rendered: null, raf: null, last: 0, visible: true, frames: 0, dirty: true };

  function renderAt(s) {
    var e = clamp(s + 1, 0, 1), p = clamp(s, 0, 1);
    applyGroups(p);
    applyCamera(p, e);
    applyLight(p);
    renderer.render(scene, camera);
    state.frames += 1;
    state.rendered = s;
    state.dirty = false;
    updateCssState(s);
    if (DEBUG) updateDebug(s);
  }

  function tick(now) {
    state.raf = null;
    var dt = Math.min(0.1, (now - state.last) / 1000);
    state.last = now;
    if (state.current === null) state.current = state.target;
    var diff = state.target - state.current;
    state.current = Math.abs(diff) < 1e-4 ? state.target : state.current + diff * (1 - Math.exp(-dt / DAMPING_SECONDS));
    if (state.dirty || state.current !== state.rendered) renderAt(state.current);
    if (state.current !== state.target) kick();
  }
  function kick() {
    if (state.raf !== null || !state.visible || document.hidden || !renderer || section.classList.contains('is-static')) return;
    state.last = performance.now();
    state.raf = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (state.raf !== null) { cancelAnimationFrame(state.raf); state.raf = null; }
  }
  function onScroll() {
    if (FORCED_S !== null || debugOverride !== null) return;
    state.target = scrollValue();
    updateCssState(state.target);
    if (renderer) updateBackgroundMode(state.target);
    if (!backgroundActive) kick();
    updateDiagnostic();
  }

  // ── Resize ──────────────────────────────────────────────────────────────
  var lastSize = { w: 0, h: 0 };
  function resizeRenderer(force) {
    var w = stage.clientWidth, h = stage.clientHeight;
    // Mobile URL-bar show/hide changes only the height slightly: keep the buffer.
    if (!force && w === lastSize.w && Math.abs(h - lastSize.h) < 120) { measure(); return; }
    lastSize = { w: w, h: h };
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    layout = currentLayout();
    fitCameraKeys();
    measure();
    state.dirty = true;
    kick();
  }
  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = null; if (renderer) resizeRenderer(false); else measure(); }, 150);
  }

  // ── Debug ───────────────────────────────────────────────────────────────
  var debugOverride = null;
  var debugPanel = null;
  function addPivotHelpers() {
    groups.forEach(function (g) {
      var helper = new THREE_.AxesHelper(0.012);
      helper.material.depthTest = false;
      helper.renderOrder = 10;
      g.node.add(helper);
      var arrow = new THREE_.ArrowHelper(g.axis.clone(), new THREE_.Vector3(), 0.025, 0xffcc00, 0.006, 0.004);
      arrow.line.material.depthTest = false;
      g.node.parent.add(arrow);
      arrow.position.copy(g.rest);
      g.helpers = [helper, arrow];
    });
  }
  function buildDebugPanel() {
    debugPanel = document.getElementById('machine-debug');
    debugPanel.hidden = false;
    debugPanel.innerHTML = '<div id="md-stage"></div>' +
      '<input id="md-s" type="range" min="-1" max="1" step="0.001" value="0" aria-label="Sequence position">' +
      '<label><input id="md-scroll" type="checkbox" checked> follow scroll</label>' +
      '<label><input id="md-pivots" type="checkbox" checked> pivot helpers</label>' +
      '<div id="md-stats"></div>';
    var slider = debugPanel.querySelector('#md-s');
    var follow = debugPanel.querySelector('#md-scroll');
    slider.addEventListener('input', function () {
      follow.checked = false;
      debugOverride = parseFloat(slider.value);
      state.target = state.current = debugOverride;
      state.dirty = true;
      kick();
    });
    follow.addEventListener('change', function () {
      debugOverride = follow.checked ? null : parseFloat(slider.value);
      onScroll();
    });
    debugPanel.querySelector('#md-pivots').addEventListener('change', function (ev) {
      groups.forEach(function (g) { (g.helpers || []).forEach(function (h) { h.visible = ev.target.checked; }); });
      state.dirty = true; kick();
    });
  }
  function updateDebug(s) {
    if (!debugPanel) return;
    var info = renderer.info;
    debugPanel.querySelector('#md-stage').textContent = 's=' + s.toFixed(3) + '  ' + (s < 0 ? 'Entry from hero' : stageAt(s)) + '  [' + layout + ']';
    debugPanel.querySelector('#md-stats').textContent = 'calls ' + info.render.calls + ' · tris ' + info.render.triangles +
      ' · textures ' + info.memory.textures + ' · programs ' + (info.programs ? info.programs.length : '?') + ' · frames ' + state.frames;
    if (document.activeElement !== debugPanel.querySelector('#md-s')) debugPanel.querySelector('#md-s').value = s;
  }

  // ── Public hooks for automated screenshots/measurements ────────────────
  window.__machine = {
    mode: 'pending',
    ready: false,
    staticReason: '',
    setS: function (s) {
      debugOverride = clamp(s, -1, 1);
      state.target = state.current = debugOverride;
      state.dirty = true;
      if (renderer) renderAt(debugOverride);
    },
    followScroll: function () { debugOverride = null; onScroll(); },
    // Renders position s and returns the canvas as a PNG data URL (poster generation).
    capture: function (s) {
      window.__machine.setS(s);
      return renderer.domElement.toDataURL('image/png');
    },
    stats: function () {
      if (!renderer) return null;
      var info = renderer.info;
      return {
        frames: state.frames,
        calls: info.render.calls,
        triangles: info.render.triangles,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
        programs: info.programs ? info.programs.length : null,
        pixelRatio: renderer.getPixelRatio(),
        size: [renderer.domElement.width, renderer.domElement.height],
        layout: layout
      };
    }
  };

  // ── Diagnostic overlay (prototype only) ────────────────────────────────
  var diagEl = null;
  function updateDiagnostic() {
    if (!DIAG) return;
    if (!diagEl) {
      diagEl = document.createElement('div');
      diagEl.style.cssText = 'position:fixed;left:8px;top:64px;z-index:9999;max-width:calc(100vw - 16px);padding:7px 9px;border-radius:8px;background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.18);font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;pointer-events:none';
      document.body.appendChild(diagEl);
    }
    var mode = window.__machine ? window.__machine.mode : 'pending';
    var ready = window.__machine && window.__machine.ready ? 'yes' : 'no';
    var s = renderer ? state.current : scrollValue();
    var target = renderer ? state.target : scrollValue();
    diagEl.textContent = 'mode=' + mode + ' ready=' + ready +
      ' forceLive=' + FORCE_LIVE +
      ' reduced=' + prefersReducedMotion() +
      ' weak=' + isWeakDevice() +
      ' webgl=' + hasWebGL() +
      (staticReason ? ' reason=' + staticReason : '') +
      ' s=' + Number(s || 0).toFixed(3) +
      ' target=' + Number(target || 0).toFixed(3);
  }

  // ── Start-up ────────────────────────────────────────────────────────────
  var started = false;
  function start() {
    if (started) return;
    started = true;
    window.removeEventListener('scroll', start);
    if (FORCE_STATIC) return enterStaticMode('forced');
    if (!FORCE_LIVE && prefersReducedMotion()) return enterStaticMode('reduced motion');
    if (!FORCE_LIVE && isWeakDevice()) return enterStaticMode('weak device or data saver');
    if (!hasWebGL()) return enterStaticMode('WebGL unavailable');
    updateDiagnostic();
    showPoster('exploded');
    var t0 = performance.now();
    loadLibraries()
      .then(function () {
        timeline = window.MACHINE_TIMELINE;
        return new Promise(function (resolve, reject) {
          new window.THREE.GLTFLoader().load(ASSETS.model, resolve, null, reject);
        });
      })
      .then(function (gltf) {
        buildScene(gltf);
        measure();
        state.target = FORCED_S !== null ? FORCED_S : scrollValue();
        if (FORCED_S !== null) debugOverride = FORCED_S;
        // If loading finished after the user already entered the sequence,
        // do not jump straight to the current scroll position. Start at the
        // beginning of assembly and smoothly catch up to the user's position.
        state.current = FORCED_S !== null ? state.target : (state.target > 0 ? 0 : state.target);
        renderAt(state.current);
        section.classList.add('is-live');
        window.__machine.mode = 'live';
        window.__machine.ready = true;
        window.__machine.loadMs = Math.round(performance.now() - t0);
        window.__machine.staticReason = '';
        updateDiagnostic();
        if (DEBUG) buildDebugPanel();
        observeVisibility();
        if (state.current !== state.target) kick();
        updateBackgroundMode(state.target);
      })
      .catch(function (error) {
        console.warn(error);
        enterStaticMode('load failed');
      });
  }

  // ── Assembled background mode (Portfolio) ───────────────────────────────
  // Mirrors the behaviour of the old homepage: after the assembly handoff,
  // keep the assembled machine slowly rotating behind Portfolio. The render
  // loop only runs while Portfolio is on screen.
  var backgroundActive = false;
  var backgroundRaf = null;
  var backgroundLast = 0;
  var backgroundAngle = 0;

  function renderBackground(now) {
    if (!backgroundActive || !renderer || document.hidden) {
      backgroundRaf = null;
      return;
    }
    if (!backgroundLast) backgroundLast = now;
    var dt = Math.min(0.1, (now - backgroundLast) / 1000);
    backgroundLast = now;
    backgroundAngle = (backgroundAngle + dt * 0.048) % (Math.PI * 2); // old scene ≈0.0008 rad/frame at 60 fps

    // Hero-pose camera/light, fully assembled geometry.
    applyGroups(0.78);
    applyCamera(0.78, 1);
    applyLight(0.78);
    machineRoot.rotation.y += backgroundAngle;
    renderer.render(scene, camera);
    state.frames += 1;
    backgroundRaf = requestAnimationFrame(renderBackground);
  }

  function startBackgroundLoop() {
    if (backgroundRaf !== null || document.hidden || !renderer) return;
    backgroundLast = 0;
    backgroundRaf = requestAnimationFrame(renderBackground);
  }

  function stopBackgroundLoop() {
    if (backgroundRaf !== null) cancelAnimationFrame(backgroundRaf);
    backgroundRaf = null;
    backgroundLast = 0;
  }

  function setBackgroundActive(active) {
    if (backgroundActive === active) return;
    backgroundActive = active;
    if (active) {
      stopLoop();
      section.classList.add('is-background');
      state.visible = true;
      startBackgroundLoop();
    } else {
      stopBackgroundLoop();
      section.classList.remove('is-background');
      state.dirty = true;
      kick();
    }
  }

  function updateBackgroundMode(s) {
    if (!portfolio || !renderer) return;
    var rect = portfolio.getBoundingClientRect();
    var portfolioVisible = rect.top < window.innerHeight && rect.bottom > 0;
    setBackgroundActive(portfolioVisible && s >= 0.995);
  }

  function observeVisibility() {
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        state.visible = entry.isIntersecting || backgroundActive;
        if (backgroundActive) return;
        if (state.visible) { state.dirty = true; kick(); } else { stopLoop(); }
      });
    }).observe(section);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopLoop();
      stopBackgroundLoop();
    } else if (backgroundActive) {
      startBackgroundLoop();
    } else {
      kick();
    }
  });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  measure();
  updateCssState(scrollValue());

  updateDiagnostic();

  if (FORCED_S !== null || DEBUG || FORCE_STATIC || FORCE_LIVE) {
    start();
  } else {
    window.addEventListener('scroll', start, { passive: true });
    // Start loading shortly after LCP instead of waiting 1.5–3.5 seconds.
    // This keeps the hero static but makes the model far more likely to be
    // ready before the user reaches the assembly section.
    window.addEventListener('load', function () {
      var idle = window.requestIdleCallback || function (cb) { return setTimeout(cb, 1); };
      setTimeout(function () { idle(start, { timeout: 500 }); }, 100);
    });
  }
})();
