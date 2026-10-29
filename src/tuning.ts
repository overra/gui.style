// Tuning panel (loaded on demand). Every value is read each frame, so edits are live.

import GUI from 'lil-gui';
import type { Theme } from './background.ts';
import { looks } from './look.ts';
import { params } from './params.ts';
import { MAX_HOVER } from './scene/scene.ts';

export interface TuningHooks {
  theme: () => Theme;
  wake: () => void;
  replayDrop: () => void;
  tap: () => void;
  /** The goo's place in the scene (scene/scene.ts): its hover height above the page. */
  goo: { hover: number };
}

type Feel = typeof params.feel;

/** A few characters to start from; every slider can be adjusted afterwards. */
const PRESETS: Record<string, Feel> = {
  'Glass putty': { viscosity: 0.5, elasticity: 0.5, imprint: 0.5, fingerprint: 0.5 },
  Jelly: { viscosity: 0.2, elasticity: 0.95, imprint: 0.3, fingerprint: 0.3 },
  Honey: { viscosity: 0.95, elasticity: 0.1, imprint: 0.55, fingerprint: 0.35 },
  'Modeling clay': { viscosity: 0.85, elasticity: 0.05, imprint: 0.9, fingerprint: 0.8 },
  'Crime scene': { viscosity: 0.6, elasticity: 0.35, imprint: 0.8, fingerprint: 1 },
};

export function openTuning(hooks: TuningHooks) {
  const gui = new GUI({ title: 'Tweak the goo', width: 310 });
  gui.onChange(() => hooks.wake());

  const feel = gui.addFolder('Goo');
  const preset = { name: 'Glass putty' };
  feel
    .add(preset, 'name', Object.keys(PRESETS))
    .name('preset')
    .onChange((name: string) => {
      Object.assign(params.feel, PRESETS[name]);
      feel.controllersRecursive().forEach((c) => c.updateDisplay());
    });
  feel.add(params.feel, 'viscosity', 0, 1, 0.01).name('viscosity (thin → thick)');
  feel.add(params.feel, 'elasticity', 0, 1, 0.01).name('elasticity (doughy → bouncy)');
  feel.add(params.feel, 'imprint', 0, 1, 0.01).name('imprint (subtle → exaggerated)');
  feel.add(params.feel, 'fingerprint', 0, 1, 0.01).name('fingerprint (none → exaggerated)');
  feel.add({ drop: hooks.replayDrop }, 'drop').name('Drop it again');
  feel.add({ tap: hooks.tap }, 'tap').name('Tap the middle');

  // Levitation: lift the button off the page; presses then push the whole button down and tilt it, and it springs
  // back. The 3D scene view (C) shows the same values in its own panel, so these follow its edits while this panel
  // shows (show() below; a listening controller polls every frame, so it stops while the panel is hidden).
  const float = gui.addFolder('Levitation');
  const followed = [
    float.add(hooks.goo, 'hover', 0, MAX_HOVER, 1).name('hover height (px)'),
    float.add(params.levitation, 'travel', 0, 30, 0.5).name('press travel (px)'),
    float.add(params.levitation, 'stiffness', 1, 15, 0.1).name('stiffness (Hz)'),
    float.add(params.levitation, 'damping', 0.05, 1.2, 0.01).name('damping (bouncy → still)'),
    float.add(params.levitation, 'tilt', 0, 1, 0.01).name('tilt toward the press'),
  ];

  // Base values: the feel macros scale these.
  const physics = gui.addFolder('Physics (base values)');
  physics.add(params.finger, 'depthFrac', 0.15, 0.85, 0.01).name('press depth');
  physics.add(params.elastic, 'zeta', 0.08, 1, 0.01).name('wobble damping');
  physics.add(params.elastic, 'omega', 15, 90, 1).name('wobble speed');
  physics.add(params.plastic, 'plasticShare', 0, 1, 0.01).name('imprint share');
  physics.add(params.plastic, 'yieldHead', 0, 6, 0.1).name('yield (rim)');
  physics.add(params.plastic, 'fluxDamping', 20, 400, 1).name('flow damping');
  physics.add(params.heal, 'hold', 0, 2, 0.05).name('imprint hold (s)');
  physics.add(params.heal, 'tau', 0.2, 4, 0.05).name('heal time (s)');
  physics.close();

  const print = gui.addFolder('Fingerprint (base values)');
  print.add(params.detail, 'depth', 0, 0.8, 0.01).name('ridge depth');
  print.add(params.detail, 'period', 2.5, 7, 0.1).name('ridge period');
  print.add(params.detail, 'fadeTau', 0.2, 4, 0.05).name('ridge fade (s)');
  print.add(params.detail, 'smoothing', 0, 1.8, 0.05).name('ridge leveling');
  print.add(params.detail, 'hazeTau', 0.2, 4, 0.05).name('smudge fade (s)');
  print.close();

  // The glass folder edits whichever theme is showing.
  const glass = gui.addFolder('Glass');
  const lookOf = () => looks[hooks.theme()];
  const proxy = {
    get depthLens() { return lookOf().depthLens; },
    set depthLens(v: number) { lookOf().depthLens = v; },
    get dispersion() { return (lookOf().iorB - lookOf().iorR) / 2; },
    set dispersion(v: number) {
      const l = lookOf();
      l.iorR = l.iorG - v;
      l.iorB = l.iorG + v;
    },
    get roughness() { return lookOf().roughness; },
    set roughness(v: number) { lookOf().roughness = v; },
    get saturation() { return lookOf().saturation; },
    set saturation(v: number) { lookOf().saturation = v; },
    get glint() { return lookOf().glint; },
    set glint(v: number) { lookOf().glint = v; },
    get shadow() { return lookOf().shadowOpacity; },
    set shadow(v: number) { lookOf().shadowOpacity = v; },
    get caustics() { return lookOf().causticC; },
    set caustics(v: number) { lookOf().causticC = v; },
  };
  glass.add(proxy, 'depthLens', 0, 16, 0.5).name('edge lensing');
  glass.add(proxy, 'dispersion', 0, 0.08, 0.002).name('dispersion');
  glass.add(proxy, 'roughness', 0.05, 0.5, 0.01).name('roughness');
  glass.add(proxy, 'saturation', 0.8, 1.6, 0.01).name('vibrancy');
  glass.add(proxy, 'glint', 0, 1, 0.01).name('edge glint');
  glass.add(proxy, 'shadow', 0, 0.6, 0.01).name('shadow');
  glass.add(proxy, 'caustics', 0, 0.5, 0.01).name('caustics');
  glass.close();

  // Poll only while the Levitation rows can be seen: the panel shown, and neither it nor the folder collapsed.
  let shown = false;
  const follow = () => {
    const on = shown && !gui._closed && !float._closed;
    for (const c of followed) c.listen(on);
  };
  gui.onOpenClose(follow);

  return {
    show(open: boolean) {
      shown = open;
      gui.show(open);
      follow();
    },
  };
}

export type Tuning = ReturnType<typeof openTuning>;
