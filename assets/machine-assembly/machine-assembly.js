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
  var portfolioIntro = document.getElementById('portfolio-intro');
  var leadFeature = portfolioIntro ? portfolioIntro.querySelector('.portfolio-feature--lead') : null;
  var followFeature = portfolioIntro ? portfolioIntro.querySelector('.portfolio-feature--follow') : null;
  var leadFeatureImg = leadFeature ? leadFeature.querySelector('img') : null;
  var followFeatureImg = followFeature ? followFeature.querySelector('img') : null;
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
    // Only explicit data-saver / extremely slow connections skip the cinematic
    // download. Safari and privacy-protecting browsers may report just two
    // logical cores or very little device memory even on capable iPhones.
    // Do not treat those coarse values as proof that WebGL cannot run:
    // hasWebGL(), the renderer, and the load-failure fallback provide the
    // actual capability gate.
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g'));
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
    section.dataset.staticReason = staticReason;
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
  // Reveal and assembly are anchored to the visible share of the machine
  // itself, not of the stage: the model occupies only part of the stage, so
  // "half the stage visible" meant much less than half the machine visible.
  // box.top/box.bottom are the machine's projected top/bottom as fractions of
  // the stage height in the opening pose (measured after the model loads).
  var REVEAL_VISIBILITY = 0.02;   // first sliver of the machine above the fold
  var ASSEMBLY_VISIBILITY = 0.30; // assembly anchor; first clear move lands at ~30–40%
  var metrics = { top: 0, distance: 1, revealStart: 0, assemblyStart: 0, assemblyEnd: 1, box: { top: 0.12, bottom: 0.93 } };
  function measure() {
    var rect = section.getBoundingClientRect();
    var vh = Math.max(1, stage.clientHeight || window.innerHeight || 1);
    metrics.top = rect.top + window.scrollY;
    metrics.distance = Math.max(1, section.offsetHeight - stage.offsetHeight);
    // Scroll position at which a given share of the machine is visible above
    // the bottom of the viewport while the stage is still rising.
    var boxHeight = Math.max(0.1, metrics.box.bottom - metrics.box.top);
    var scrollForVisibility = function (share) {
      return metrics.top + (metrics.box.top + share * boxHeight) * vh - vh;
    };
    metrics.revealStart = Math.min(scrollForVisibility(REVEAL_VISIBILITY), metrics.top - vh * 0.05);
    metrics.assemblyStart = Math.max(metrics.revealStart + vh * 0.12, scrollForVisibility(ASSEMBLY_VISIBILITY));
    metrics.assemblyEnd = metrics.top + metrics.distance;
  }
  function scrollValue() {
    var y = window.scrollY;
    if (y <= metrics.revealStart) return -1;
    if (y < metrics.assemblyStart) {
      return -1 + clamp((y - metrics.revealStart) / Math.max(1, metrics.assemblyStart - metrics.revealStart), 0, 1);
    }
    return clamp((y - metrics.assemblyStart) / Math.max(1, metrics.assemblyEnd - metrics.assemblyStart), 0, 1);
  }

  // Handoff: the first full-screen tattoo is the continuation of the final
  // close-up. It lies over the last viewport of the machine section and fades
  // in while the exposure falls to black. Once the page scrolls past the end
  // of the sticky stage it is forced opaque, so a lagging (damped) 3D state
  // can never show the stage sliding away underneath.
  function pastStageShare() {
    var vh = Math.max(1, window.innerHeight || 1);
    return (window.scrollY - metrics.assemblyEnd) / vh;
  }
  // Close-up -> black: the stage is covered before the tattoo fades in, so the
  // machine and the tattoo never cross-fade on screen.
  function blackoutAmount(p) {
    // Fade the whole 3D scene to black only at the very end. On a fast fling,
    // complete the fade over a short real-scroll distance so it never becomes
    // a long empty black screen.
    return Math.max(
      smooth((p - 0.952) / 0.026),
      smooth(pastStageShare() / 0.04)
    );
  }
  function handoffAmount(p) {
    // Bring the full-screen tattoo in as the blackout is finishing, not after
    // a separate black hold. This keeps the order machine -> black -> tattoo
    // while avoiding a visible pause between them.
    var fromSequence = smooth((p - 0.964) / 0.026);
    var pastStage = smooth(pastStageShare() / 0.055);
    return Math.max(fromSequence, pastStage);
  }

  function updatePortfolioMotion() {
    if (!portfolioIntro || !leadFeatureImg || !followFeatureImg) return;

    var desktop = window.matchMedia && window.matchMedia('(min-width: 900px)').matches;
    var leadBase = desktop ? 1.12 : 1.18;
    var followBase = desktop ? 1.03 : 1.06;

    if (prefersReducedMotion()) {
      leadFeatureImg.style.transform = 'scale(' + leadBase.toFixed(3) + ')';
      followFeatureImg.style.transform = 'scale(' + followBase.toFixed(3) + ')';
      return;
    }

    var vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    function viewProgress(el) {
      if (!el) return 0;
      var rect = el.getBoundingClientRect();
      return smooth(clamp((vh - rect.top) / Math.max(1, vh + rect.height), 0, 1));
    }

    // Direct image transforms are more reliable on Safari than inherited
    // custom properties inside scale(calc()). The change remains restrained
    // but is intentionally visible during the viewport pass.
    var leadScale = leadBase + 0.12 * viewProgress(leadFeature);
    var followScale = followBase + 0.10 * viewProgress(followFeature);
    leadFeatureImg.style.transform = 'scale(' + leadScale.toFixed(4) + ')';
    followFeatureImg.style.transform = 'scale(' + followScale.toFixed(4) + ')';
  }

  function updateCssState(s) {
    var e = clamp(s + 1, 0, 1);
    var p = clamp(s, 0, 1);
    section.style.setProperty('--entry-shade', (1 - smooth(e / 0.85)).toFixed(3));
    section.style.setProperty('--skip-opacity', (p > 0.02 && p < 0.9 ? 1 : 0).toString());
    section.style.setProperty('--glow', ((1 - smooth((p - 0.86) / 0.1)) * smooth(e / 0.9)).toFixed(3));
    // Fast flings past the end of the stage: black the stage out first, so
    // the order stays machine → black → tattoo even if the damped 3D lags.
    section.style.setProperty('--stage-blackout', blackoutAmount(p).toFixed(3));
    if (portfolioIntro && !section.classList.contains('is-static')) {
      var handoff = handoffAmount(p);
      portfolioIntro.style.setProperty('--handoff', handoff.toFixed(3));
      portfolioIntro.style.setProperty('--handoff-scale', (1.006 - 0.006 * handoff).toFixed(4));
    }
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
  var groupByName = {};
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
      groupByName[node.name] = entry;
    });
    if (groups.length !== 18) throw new Error('Expected 18 groups, found ' + groups.length);
    groups.forEach(function (g) {
      g.node.traverse(function (o) { if (o.isMesh) o.material.envMapIntensity = 1.0; });
    });
    createWorkingFx();

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

  // Anticipation during the reveal: the exploded parts start ~8% wider and
  // gather toward their seats from ~30% of the reveal path, so the machine is
  // already "alive" before the first real assembly move.
  var entryE = 1;
  function anticipationScale() {
    return 1 + 0.08 * (1 - smooth((entryE - 0.3) / 0.7));
  }

  function applyGroups(p) {
    var gather = anticipationScale();
    groups.forEach(function (g) {
      var spec = g.spec;
      var t = clamp((p - spec.window[0]) / (spec.window[1] - spec.window[0]), 0, 1);
      var k = (1 - easeInOutCubic(t)) * (t < 1 ? gather : 1); // 1 = exploded, 0 = seated
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

  // ── Working machine + one-off needle light pass ─────────────────────────
  // The pass is a thin camera-facing strip along the needle's own long axis
  // (not a sphere): a short trace with a tiny bright leading edge travels from
  // the top of the needle bar to the tip, then a very small flash marks the
  // tip and everything fades out. It plays once per page view, ~300 ms after
  // the machine starts working, and never in the background loop.
  var LIGHT_DELAY_MS = 300, LIGHT_TRAVEL_MS = 620, LIGHT_FLASH_MS = 240;
  var lightPass = { done: false, start: 0 };
  var needleAxis = null; // { a, b } needle end points in needle-node space
  var beam = null, tipFlash = null, beamPos = null;
  var tmpA = null, tmpB = null, tmpSide = null, tmpView = null, tmpMid = null;

  function measureNeedleAxis(node) {
    node.updateMatrixWorld(true);
    var inv = new THREE_.Matrix4().copy(node.matrixWorld).invert();
    var box = new THREE_.Box3(), part = new THREE_.Box3(), m = new THREE_.Matrix4();
    node.traverse(function (o) {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m.multiplyMatrices(inv, o.matrixWorld);
      box.union(part.copy(o.geometry.boundingBox).applyMatrix4(m));
    });
    var size = box.getSize(new THREE_.Vector3()), c = box.getCenter(new THREE_.Vector3());
    var axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');
    var a = c.clone(), b = c.clone();
    a[axis] -= size[axis] / 2; b[axis] += size[axis] / 2;
    return { a: a, b: b };
  }

  function createWorkingFx() {
    tmpA = new THREE_.Vector3(); tmpB = new THREE_.Vector3();
    tmpSide = new THREE_.Vector3(); tmpView = new THREE_.Vector3(); tmpMid = new THREE_.Vector3();
    var needle = groupByName.G17_needle;
    if (!needle) return;
    needleAxis = measureNeedleAxis(needle.node);

    // Strip: x runs along the needle (0 top → 1 tip), y across (-1..1).
    var beamGeo = new THREE_.BufferGeometry();
    beamPos = new Float32Array(12);
    beamGeo.setAttribute('position', new THREE_.BufferAttribute(beamPos, 3));
    beamGeo.setAttribute('uv', new THREE_.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2));
    beamGeo.setIndex([0, 2, 1, 2, 3, 1]);
    beam = new THREE_.Mesh(beamGeo, new THREE_.ShaderMaterial({
      uniforms: { uHead: { value: 0 }, uTrail: { value: 0.2 }, uAlpha: { value: 0 }, uColor: { value: new THREE_.Color(0xeef5ff) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform float uHead; uniform float uTrail; uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;',
        'void main(){',
        '  float d = uHead - vUv.x;',
        '  float along = d >= 0.0 ? exp(-d / uTrail) : exp(d / 0.01);',
        '  float edge = exp(-(d * d) / 0.00035);',
        '  float y2 = vUv.y * vUv.y;',
        '  float a = (along * 0.55 * exp(-y2 * 9.0) + edge * exp(-y2 * 45.0)) * uAlpha;',
        '  gl_FragColor = vec4(uColor, a);',
        '}'
      ].join('\n'),
      transparent: true, blending: THREE_.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE_.DoubleSide // winding flips with the camera side of the needle
    }));
    beam.frustumCulled = false;
    beam.renderOrder = 30;
    beam.visible = false;
    scene.add(beam);

    tipFlash = new THREE_.Mesh(new THREE_.PlaneGeometry(1, 1), new THREE_.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE_.Color(0xffffff) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv; void main(){ float r2 = dot(vUv, vUv); float a = (exp(-r2 * 30.0) + 0.25 * exp(-vUv.y * vUv.y * 400.0) * exp(-vUv.x * vUv.x * 6.0)) * uAlpha; gl_FragColor = vec4(uColor, a); }',
      transparent: true, blending: THREE_.AdditiveBlending, depthWrite: false, depthTest: false
    }));
    tipFlash.renderOrder = 31;
    tipFlash.visible = false;
    scene.add(tipFlash);
  }

  function hideWorkingFx() {
    if (beam) beam.visible = false;
    if (tipFlash) tipFlash.visible = false;
  }

  // World size of one CSS pixel at a given point.
  function worldPerPixel(point) {
    var dist = tmpView.copy(point).sub(camera.position).length();
    return 2 * dist * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, stage.clientHeight);
  }

  function drawLightPass(now) {
    var t = (now - lightPass.start) / LIGHT_TRAVEL_MS;
    if (t < 0) { hideWorkingFx(); return; }
    var flashT = (now - lightPass.start - LIGHT_TRAVEL_MS * 0.92) / LIGHT_FLASH_MS;
    if (flashT >= 1) { lightPass.done = true; lightPass.start = 0; hideWorkingFx(); return; }

    var node = groupByName.G17_needle.node;
    tmpA.copy(needleAxis.a); node.localToWorld(tmpA);
    tmpB.copy(needleAxis.b); node.localToWorld(tmpB);
    if (tmpA.y < tmpB.y) { var sw = tmpA; tmpA = tmpB; tmpB = sw; } // tmpA top, tmpB tip

    // Beam: head eases toward the tip, the trace fades out as it lands.
    var travel = clamp(t, 0, 1);
    var head = lerp(-0.04, 1.0, travel < 0.5 ? 2 * travel * travel : 1 - Math.pow(-2 * travel + 2, 2) / 2);
    var alpha = smooth(t / 0.15) * (1 - smooth((t - 0.9) / 0.22));
    if (alpha > 0.002) {
      var mid = tmpMid.copy(tmpA).add(tmpB).multiplyScalar(0.5);
      var halfWidth = 3.2 * worldPerPixel(mid);
      tmpSide.copy(tmpB).sub(tmpA).cross(tmpView.copy(camera.position).sub(mid)).normalize().multiplyScalar(halfWidth);
      beamPos[0] = tmpA.x - tmpSide.x; beamPos[1] = tmpA.y - tmpSide.y; beamPos[2] = tmpA.z - tmpSide.z;
      beamPos[3] = tmpA.x + tmpSide.x; beamPos[4] = tmpA.y + tmpSide.y; beamPos[5] = tmpA.z + tmpSide.z;
      beamPos[6] = tmpB.x - tmpSide.x; beamPos[7] = tmpB.y - tmpSide.y; beamPos[8] = tmpB.z - tmpSide.z;
      beamPos[9] = tmpB.x + tmpSide.x; beamPos[10] = tmpB.y + tmpSide.y; beamPos[11] = tmpB.z + tmpSide.z;
      beam.geometry.attributes.position.needsUpdate = true;
      beam.material.uniforms.uHead.value = head;
      beam.material.uniforms.uAlpha.value = alpha;
      beam.visible = true;
    } else {
      beam.visible = false;
    }

    // Tip flash: tiny (≈12 px), short, camera-facing.
    if (flashT > 0) {
      var flash = Math.sin(Math.PI * Math.pow(clamp(flashT, 0, 1), 0.6));
      tipFlash.position.copy(tmpB);
      tipFlash.quaternion.copy(camera.quaternion);
      tipFlash.scale.setScalar(12 * worldPerPixel(tmpB));
      tipFlash.material.uniforms.uAlpha.value = flash * 0.9;
      tipFlash.visible = flash > 0.002;
    } else {
      tipFlash.visible = false;
    }
  }

  // allowPass is false for the background loop: mechanics only, no light.
  function applyWorkingFx(p, now, intensityScale, allowPass) {
    var active = smooth((p - 0.74) / 0.035) * (intensityScale == null ? 1 : intensityScale);
    var needle = groupByName.G17_needle;
    var armature = groupByName.G06_armature_bar;
    var spring = groupByName.G07_spring;
    if (!needle || !armature || !spring || active <= 0.001) {
      // Scrolled back out of the working pose before the pass finished: drop it.
      if (lightPass.start) { lightPass.start = 0; lightPass.done = true; }
      hideWorkingFx();
      return false;
    }

    var seconds = now * 0.001;
    // Deliberately lower than a real machine frequency so the motion reads
    // cleanly on 60 Hz phone displays instead of aliasing into a frozen blur.
    var wave = Math.sin(seconds * Math.PI * 2 * 18);
    needle.node.position.y += wave * 0.00145 * active;
    armature.node.position.y += wave * 0.00085 * active;
    spring.node.rotateZ(wave * 0.009 * active);

    if (!allowPass || !needleAxis) {
      hideWorkingFx();
      return true;
    }
    // Arm once, when the assembled machine starts working. A fling that lands
    // deep in the push-in skips the pass instead of playing it late.
    if (!lightPass.done && !lightPass.start && p >= 0.745) {
      if (p <= 0.86) lightPass.start = now + LIGHT_DELAY_MS;
      else lightPass.done = true;
    }
    if (lightPass.start) {
      machineRoot.updateMatrixWorld(true);
      drawLightPass(now);
    } else {
      hideWorkingFx();
    }
    return true;
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
      var savedE = entryE;
      entryE = 1;
      applyGroups(key.p);
      entryE = savedE;
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

  function renderAt(s, now) {
    var e = clamp(s + 1, 0, 1), p = clamp(s, 0, 1);
    var frameNow = now || performance.now();
    entryE = e;
    applyGroups(p);
    applyCamera(p, e);
    applyLight(p);
    applyWorkingFx(p, frameNow, 1, true);
    renderer.render(scene, camera);
    state.frames += 1;
    state.rendered = s;
    state.dirty = false;
    updateCssState(s);
    if (DEBUG) updateDebug(s);
  }

  function tick(now) {
    state.raf = null;
    // rAF timestamps can precede the performance.now() taken in kick(); a
    // negative dt would make the exponential step overshoot.
    var dt = clamp((now - state.last) / 1000, 0, 0.1);
    state.last = now;
    if (state.current === null) state.current = state.target;
    var diff = state.target - state.current;
    // Adaptive damping, no snap: ~650 ms near the target, progressively
    // faster when a fast inertial swipe leaves the 3D far behind, so the close-up
    // and black frame are reached before the tattoo handoff covers the stage.
    var lag = Math.abs(diff);
    var tau = DAMPING_SECONDS / (1 + 5 * Math.max(0, lag - 0.08));
    state.current = lag < 1e-4 ? state.target : state.current + diff * (1 - Math.exp(-dt / tau));
    var working = (state.current >= 0.74 && state.current < 0.995) || lightPass.start > 0;
    if (state.dirty || state.current !== state.rendered || working) renderAt(state.current, now);
    if (state.current !== state.target || working) kick();
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
    updatePortfolioMotion();
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
    measureMachineBox();
    measure();
    state.dirty = true;
    kick();
  }

  // Projected top/bottom of the machine (opening pose, fitted camera) as
  // fractions of the stage height; feeds the visibility-based scroll anchors.
  function measureMachineBox() {
    var savedE = entryE;
    entryE = 1;
    applyGroups(0);
    applyCamera(0, 1);
    machineRoot.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    var box = new THREE_.Box3();
    var v = new THREE_.Vector3();
    var minY = Infinity, maxY = -Infinity;
    groups.forEach(function (g) {
      if (g.spec.fade) return; // hidden in the opening pose
      box.setFromObject(g.node);
      for (var i = 0; i < 8; i += 1) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
    });
    entryE = savedE;
    metrics.box.top = clamp((1 - maxY) / 2, 0, 1);
    metrics.box.bottom = clamp((1 - minY) / 2, 0, 1);
    state.dirty = true;
  }
  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (renderer) resizeRenderer(false); else measure();
      updatePortfolioMotion();
    }, 150);
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
      if (renderer) renderAt(debugOverride, performance.now());
    },
    followScroll: function () { debugOverride = null; onScroll(); },
    // Read-only snapshot for automated pacing checks (prototype only).
    debugState: function () {
      var vh = Math.max(1, window.innerHeight || 1);
      var stageRect = stage.getBoundingClientRect();
      var boxHeight = (metrics.box.bottom - metrics.box.top) * stageRect.height;
      var machineTop = stageRect.top + metrics.box.top * stageRect.height;
      return {
        target: state.target,
        current: state.current,
        visibleShare: clamp((vh - machineTop) / Math.max(1, boxHeight), 0, 1),
        box: { top: metrics.box.top, bottom: metrics.box.bottom },
        revealStart: Math.round(metrics.revealStart),
        assemblyStart: Math.round(metrics.assemblyStart),
        assemblyEnd: Math.round(metrics.assemblyEnd),
        background: backgroundActive,
        light: {
          done: lightPass.done,
          playing: lightPass.start > 0,
          beam: !!(beam && beam.visible),
          head: beam ? beam.material.uniforms.uHead.value : 0,
          flash: !!(tipFlash && tipFlash.visible)
        }
      };
    },
    // Test hook: renders the current pose with the light pass frozen at `ms`
    // after its start (slow software renderers cannot sample it in real time).
    // lightFrame(null) ends the pass as played.
    lightFrame: function (ms) {
      stopLoop();
      if (ms === null) { lightPass.start = 0; lightPass.done = true; hideWorkingFx(); }
      else { lightPass.done = false; lightPass.start = 1; renderAt(state.current, 1 + ms); }
      return window.__machine.debugState().light;
    },
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
  var loadPhase = 'idle';
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
    loadPhase = 'libraries';
    loadLibraries()
      .then(function () {
        timeline = window.MACHINE_TIMELINE;
        loadPhase = 'model';
        return new Promise(function (resolve, reject) {
          new window.THREE.GLTFLoader().load(ASSETS.model, resolve, null, reject);
        });
      })
      .then(function (gltf) {
        loadPhase = 'scene';
        buildScene(gltf);
        measure();
        state.target = FORCED_S !== null ? FORCED_S : scrollValue();
        if (FORCED_S !== null) debugOverride = FORCED_S;
        // If loading finished after the user already entered the sequence,
        // do not jump straight to the current scroll position. Start at the
        // beginning of assembly and smoothly catch up to the user's position.
        // When the stage is already covered by the tattoo handoff (reload
        // further down the page), start at the scroll position: nothing to show.
        var covered = handoffAmount(clamp(state.target, 0, 1)) >= 0.999;
        state.current = FORCED_S !== null || covered ? state.target : (state.target > 0 ? 0 : state.target);
        renderAt(state.current);
        section.classList.add('is-live');
        delete section.dataset.staticReason;
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
        var detail = error && (error.message || error.statusText) ? ': ' + (error.message || error.statusText) : '';
        enterStaticMode('load failed [' + loadPhase + ']' + detail);
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
    machineRoot.rotation.y = backgroundAngle;
    applyWorkingFx(0.78, now, 0.72, false);
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
      // The sequence stage is hidden under Portfolio now; align its state with
      // the scroll position so returning upward does not replay the assembly.
      state.current = state.target;
      state.rendered = null;
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

  // The background machine belongs to the grid only. During the cinematic
  // tattoo intro (opaque, full screen) it is not active, so it can never show
  // between the close-up and the tattoos. It fades in with the grid.
  function updateBackgroundMode(s) {
    if (!renderer) return;
    var vh = window.innerHeight || document.documentElement.clientHeight || 1;
    var gridVisible = false;
    var reveal = 0;
    if (portfolio) {
      var rect = portfolio.getBoundingClientRect();
      gridVisible = rect.top < vh && rect.bottom > 0;
      reveal = smooth((vh - rect.top) / (vh * 0.6));
    }
    section.style.setProperty('--bg-reveal', reveal.toFixed(3));
    setBackgroundActive(gridVisible && s >= 0.995);
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
  updatePortfolioMotion();

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
