# Phase 2.5 plan — cinematic machine-to-portfolio handoff

## Goal

Turn the isolated Phase 2 machine prototype into the final visual sequence to approve
before production integration. Keep production untouched.

Target story:

1. the machine enters from the hero;
2. assembly starts when roughly 40–50% of the machine/stage is visible;
3. the machine completes assembly and visibly starts working;
4. a light pulse travels down the needle to the tip;
5. the camera pushes into the machine and the frame occludes to black;
6. the black frame hands off to full-screen tattoo close-ups;
7. after two cinematic close-ups, the normal portfolio grid begins;
8. the assembled machine keeps slowly rotating and working behind the portfolio;
9. the renderer stops after the portfolio scene leaves the viewport.

## Pacing

### Entry vs assembly

Entry and assembly are separate phases.

- Reveal begins when the 3D stage is about 15% visible.
- Assembly begins when the stage is about 50% visible.
- The reveal-to-assembly pre-roll is therefore about 35% of one viewport, not
  multiple full swipes.
- Mobile sticky distance is reduced from 110vh to 80vh.
- Desktop sticky distance is reduced from 140vh to 110vh.
- Assembly progress starts before the stage becomes sticky, so the first meaningful
  part movement is visible during the first normal encounter with the machine.

### Sequence timeline

- 0–74%: mechanical assembly.
- 74–80%: assembled hero moment; the machine starts running.
- 80–94%: camera push-in while the mechanism continues running.
- 94–100%: frame occlusion / exposure-to-black / tattoo handoff.

## Working-machine effect

After assembly:

- armature: small vertical oscillation;
- needle: small vertical reciprocation;
- spring: very small flex/rotation;
- motion is visual rather than physically frequency-accurate so it reads on 60 Hz
  displays without looking like whole-object vibration;
- a short emissive pulse travels from the upper needle bar to the needle tip roughly
  every 1.6 s;
- the pulse ends with a brief tip flash;
- no post-processing or bloom dependency; use lightweight additive meshes only.

The working effect remains active while the machine rotates behind Portfolio, at the
same or slightly reduced intensity.

## Tattoo handoff

- The final machine close-up still goes to near-black.
- The first tattoo image begins to appear only in the final occlusion window.
- The same first tattoo then leads into a full-viewport portfolio feature.
- Add two full-viewport tattoo feature panels before the existing grid.
- Feature images use scroll-linked opacity/scale rather than an unrelated entrance
  animation.
- The grid remains the normal browseable portfolio after the cinematic intro.

Prototype image order for approval:
1. assets/portfolio/01.jpg
2. assets/portfolio/02.jpg

The order can be changed later without changing the animation architecture.

## Background continuity

- Once the machine handoff reaches Portfolio, the assembled machine becomes the
  subtle fixed background.
- It rotates at approximately the same slow rate as the old homepage.
- Needle/armature motion and the pulse continue.
- It remains behind the full-screen tattoo intro and grid.
- Rendering stops when neither the tattoo intro nor portfolio is visible.

## Mobile/runtime constraints

- Keep the iOS TextureLoader fallback and CSP blob: allowance already required by
  the embedded GLB textures.
- No GSAP dependency in the prototype.
- No snap threshold for ordinary touch scrolling.
- Scroll damping stays around 650 ms.
- A delayed GLB load must catch up smoothly instead of jumping directly to the
  assembled pose.
- Diagnostic mode remains opt-in via ?diag=1; forceLive remains prototype-only.

## Acceptance criteria

1. On iPhone, first meaningful assembly motion begins while the stage is around
   half visible, without two empty swipes.
2. No exploded-to-assembled jump during normal or inertial scrolling.
3. Machine visibly starts working before the final push-in.
4. Needle pulse reaches the tip and repeats without looking like a neon tube.
5. Final push-in hands off to a full-screen tattoo image, not directly to the grid.
6. Two full-screen tattoo features appear before the grid.
7. Machine continues slow rotation and working motion behind Portfolio.
8. No renderer loop after the portfolio scene leaves the viewport.
9. Production files remain untouched until visual approval.
