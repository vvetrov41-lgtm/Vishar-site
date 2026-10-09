/* Assembly timeline for the homepage machine sequence prototype.
 *
 * Pure data, evaluated as a function of scroll progress p ∈ [0, 1] (after the
 * stage sticks). Shared by machine-assembly.js (browser) and
 * scripts/machine-model/check-assembly-paths.mjs (Node, via vm).
 *
 * Units: metres and radians in glTF Y-up model space. X points toward the
 * needle, Y up, Z toward the side that carries the frame upright (camera side).
 *
 * Per group:
 *   window   [start, end] progress range of the move
 *   offset   exploded translation per layout (landscape / portrait)
 *   along    'axis' → offset is `distance` along the group's pivot axis
 *   via      optional waypoint (relative to the seat): the part first travels
 *            offset → via, then via → seat, so it inserts along its seat axis
 *   rot      exploded rotation { axis: [x,y,z] | 'axis', angle } about the pivot
 *   turns    screw turns about the pivot axis, spent in the last `threadShare`
 *            of the window
 *   fade     true → the group appears with opacity instead of flying (wiring)
 *   scale    exploded uniform scale (rubber bands)
 */
var MACHINE_TIMELINE = {
  stages: [
    { id: 'A', name: 'Opening frame', from: 0.0, to: 0.06 },
    { id: 'B', name: 'Frame, tube stem, needle', from: 0.0, to: 0.2 },
    { id: 'C', name: 'Coils and capacitor', from: 0.02, to: 0.31 },
    { id: 'D', name: 'Upper mechanism', from: 0.27, to: 0.58 },
    { id: 'E', name: 'Grip and tip', from: 0.52, to: 0.66 },
    { id: 'F', name: 'Fine hardware, wiring, bands', from: 0.58, to: 0.745 },
    { id: 'G', name: 'Hero moment', from: 0.745, to: 0.8 },
    { id: 'H', name: 'Camera push-in', from: 0.8, to: 0.94 },
    { id: 'I', name: 'Transition to Portfolio', from: 0.94, to: 1.0 }
  ],

  groups: {
    G01_frame: {
      window: [0.0, 0.08],
      offset: { landscape: [0, -0.004, 0], portrait: [0, -0.004, 0] },
      rot: { axis: [0, 1, 0], angle: 0.14 }
    },
    /* Starts fully below the vise so the frame can settle around it. */
    G14_tube_stem: {
      window: [0.03, 0.13],
      offset: { landscape: [0, -0.05, 0], portrait: [0, -0.06, 0] }
    },
    /* The needle drops through the column before the armature arrives: it is
     * 20 cm long, so any hover above its seat crosses the armature's path.
     * Grip and tip later slide up around it, coaxially. */
    G17_needle: {
      window: [0.07, 0.2],
      offset: { landscape: [0, 0.06, 0], portrait: [0, 0.09, 0] }
    },
    /* The frame's side plate occupies the camera side (+Z) from y 21 to 99 mm,
     * so coils come straight down from above (only the yoke is below them). */
    G02_coil_rear: {
      window: [0.02, 0.16],
      offset: { landscape: [-0.01, 0.065, -0.025], portrait: [-0.008, 0.08, -0.02] },
      via: { landscape: [0, 0.035, 0], portrait: [0, 0.035, 0] },
      rot: { axis: [0, 1, 0], angle: 0.7 }
    },
    G03_coil_front: {
      window: [0.09, 0.23],
      offset: { landscape: [0.0, 0.075, -0.02], portrait: [0.004, 0.09, -0.015] },
      via: { landscape: [0, 0.04, 0], portrait: [0, 0.04, 0] },
      rot: { axis: [0, 1, 0], angle: -0.6 }
    },
    /* Trapped between the coils and the upright: only a drop from above is clear. */
    G04_capacitor: {
      window: [0.24, 0.31],
      offset: { landscape: [-0.012, 0.075, -0.004], portrait: [-0.008, 0.075, -0.004] },
      via: { landscape: [0, 0.045, -0.001], portrait: [0, 0.045, -0.001] }
    },
    G06_armature_bar: {
      window: [0.27, 0.4],
      offset: { landscape: [0, 0.045, -0.06], portrait: [0, 0.06, -0.06] },
      via: { landscape: [0, 0.02, 0], portrait: [0, 0.02, 0] },
      rot: { axis: [0, 0, 1], angle: 0.08 }
    },
    G07_spring: {
      window: [0.4, 0.5],
      offset: { landscape: [-0.05, 0.075, -0.03], portrait: [-0.03, 0.09, -0.02] },
      via: { landscape: [0, 0.018, 0], portrait: [0, 0.018, 0] },
      rot: { axis: [0, 0, 1], angle: 0.2 }
    },
    G10_contact_barrel: {
      window: [0.42, 0.51],
      along: 'axis',
      offset: { landscape: 0.085, portrait: 0.055 }
    },
    G11_contact_screw: {
      window: [0.52, 0.62],
      along: 'axis',
      offset: { landscape: 0.08, portrait: 0.075 },
      turns: 4,
      threadShare: 0.55
    },
    /* Grip and tip travel along the column axis only, around the seated needle. */
    G15_grip: {
      window: [0.52, 0.63],
      offset: { landscape: [0, -0.07, 0], portrait: [0, -0.08, 0] },
      rot: { axis: [0, 1, 0], angle: 1.2 }
    },
    G16_tip: {
      window: [0.56, 0.66],
      offset: { landscape: [0, -0.1, 0], portrait: [0, -0.12, 0] }
    },
    G12_binding_post: {
      window: [0.58, 0.68],
      offset: { landscape: [-0.08, 0.0, 0.02], portrait: [-0.03, 0.035, 0.01] },
      via: { landscape: [0, 0.02, 0], portrait: [0, 0.02, 0] },
      rot: { axis: [0, 1, 0], angle: 1.5 }
    },
    G08_armature_clamp_hw: {
      window: [0.6, 0.69],
      along: 'axis',
      offset: { landscape: 0.11, portrait: 0.13 },
      turns: 3,
      threadShare: 0.4
    },
    G09_rear_saddle_hw: {
      window: [0.62, 0.71],
      along: 'axis',
      offset: { landscape: 0.11, portrait: 0.13 },
      turns: 3,
      threadShare: 0.4
    },
    G13_vise_screw: {
      window: [0.63, 0.72],
      along: 'axis',
      offset: { landscape: -0.08, portrait: -0.05 },
      turns: 2,
      threadShare: 0.5
    },
    G05_wiring: {
      window: [0.65, 0.73],
      offset: { landscape: [0, 0.004, 0.006], portrait: [0, 0.004, 0.006] },
      fade: true
    },
    G18_rubber_bands: {
      window: [0.69, 0.745],
      offset: { landscape: [0, 0, 0.004], portrait: [0, 0, 0.004] },
      fade: true,
      scale: 1.06
    }
  },

  /* Camera keys. `target` in model space; `dir` is the direction from target
   * to camera (normalised at runtime) and `dist` the distance; `pos` overrides
   * dir/dist for the close-up keys. fov is vertical, degrees. `fit` keys have
 * target and dist re-solved at runtime so every group, in its pose at that
 * progress, fits the viewport safe area (margins as fractions of the viewport). */
  camera: {
    landscape: [
      { p: 0.0, target: [-0.008, -0.022, 0.02], dir: [0.55, 0.16, 1], dist: 0.78, fov: 30, roll: 0, fit: { top: 0.03, bottom: 0.05, side: 0.08 } },
      { p: 0.4, target: [0.0, -0.012, 0.006], dir: [0.57, 0.17, 1], dist: 0.66, fov: 30, roll: 0, fit: { top: 0.04, bottom: 0.06, side: 0.1 } },
      { p: 0.74, target: [0.006, -0.008, 0], dir: [0.62, 0.17, 1], dist: 0.56, fov: 30, roll: 0, fit: { top: 0.06, bottom: 0.07, side: 0.1 } },
      { p: 0.8, target: [0.006, -0.006, 0], dir: [0.8, 0.2, 1], dist: 0.54, fov: 30, roll: 0, fit: { top: 0.06, bottom: 0.07, side: 0.1 } },
      { p: 0.88, target: [0.0, 0.062, -0.004], pos: [0.095, 0.085, 0.13], fov: 26, roll: -0.01 },
      { p: 0.94, target: [0.002, 0.062, -0.004], pos: [0.05, 0.07, 0.07], fov: 25, roll: -0.018 },
      { p: 0.98, target: [0.014, 0.06, 0.0], pos: [0.02, 0.061, 0.034], fov: 24, roll: -0.024 },
      { p: 1.0, target: [0.014, 0.058, 0.0], pos: [0.015, 0.058, 0.026], fov: 24, roll: -0.026 }
    ],
    portrait: [
      { p: 0.0, target: [0.008, 0.012, 0.01], dir: [0.5, 0.14, 1], dist: 0.92, fov: 38, roll: 0, fit: { top: 0.03, bottom: 0.05, side: 0.08 } },
      { p: 0.4, target: [0.008, 0.016, 0.004], dir: [0.52, 0.15, 1], dist: 0.76, fov: 38, roll: 0, fit: { top: 0.04, bottom: 0.06, side: 0.1 } },
      { p: 0.74, target: [0.008, -0.008, 0], dir: [0.6, 0.16, 1], dist: 0.54, fov: 38, roll: 0, fit: { top: 0.06, bottom: 0.07, side: 0.1 } },
      { p: 0.8, target: [0.008, -0.006, 0], dir: [0.78, 0.19, 1], dist: 0.52, fov: 38, roll: 0, fit: { top: 0.06, bottom: 0.07, side: 0.1 } },
      { p: 0.88, target: [0.004, 0.058, -0.004], pos: [0.08, 0.08, 0.14], fov: 34, roll: -0.01 },
      { p: 0.94, target: [0.004, 0.06, -0.004], pos: [0.045, 0.068, 0.075], fov: 32, roll: -0.018 },
      { p: 0.98, target: [0.014, 0.06, 0.0], pos: [0.019, 0.061, 0.036], fov: 30, roll: -0.024 },
      { p: 1.0, target: [0.014, 0.058, 0.0], pos: [0.015, 0.058, 0.027], fov: 30, roll: -0.026 }
    ]
  },

  /* Lighting and exposure keys (shared by both layouts). keyAzimuth rotates the
   * warm key light around the vertical axis (radians). */
  light: [
    { p: 0.0, exposure: 1.0, keyAzimuth: -0.35, key: 3.0, rim: 3.0 },
    { p: 0.72, exposure: 1.05, keyAzimuth: -0.35, key: 3.0, rim: 3.0 },
    { p: 0.8, exposure: 1.1, keyAzimuth: 0.2, key: 3.2, rim: 3.2 },
    { p: 0.88, exposure: 1.05, keyAzimuth: 0.35, key: 2.8, rim: 3.8 },
    { p: 0.94, exposure: 0.8, keyAzimuth: 0.4, key: 2.2, rim: 3.6 },
    { p: 0.98, exposure: 0.3, keyAzimuth: 0.4, key: 1.6, rim: 3.0 },
    { p: 1.0, exposure: 0.0, keyAzimuth: 0.4, key: 1.0, rim: 2.0 }
  ]
};

if (typeof module !== 'undefined') module.exports = MACHINE_TIMELINE;
