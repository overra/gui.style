// Optional tuning panel (loaded only with ?tune, or in dev). Every value is read each frame, so edits are live.

import GUI from 'lil-gui';
import type { Theme } from './background.ts';
import { looks } from './look.ts';
import { params } from './params.ts';

export interface TuningHooks {
  theme: () => Theme;
  wake: () => void;
  replayDrop: () => void;
  tap: () => void;
}

export function openTuning(hooks: TuningHooks) {
  const gui = new GUI({ title: 'Goo tuning', width: 300 });
  gui.onChange(() => hooks.wake());

  const feel = gui.addFolder('Feel');
  feel.add(params.finger, 'depthFrac', 0.15, 0.85, 0.01).name('press depth');
  feel.add(params.elastic, 'zeta', 0.08, 1, 0.01).name('wobble damping');
  feel.add(params.elastic, 'omega', 15, 90, 1).name('wobble speed');
  feel.add(params.plastic, 'plasticShare', 0, 1, 0.01).name('imprint share');
  feel.add(params.plastic, 'yieldHead', 0, 6, 0.1).name('yield (rim)');
  feel.add(params.heal, 'hold', 0, 2, 0.05).name('imprint hold (s)');
  feel.add(params.heal, 'tau', 0.2, 4, 0.05).name('heal time (s)');

  const print = gui.addFolder('Fingerprint');
  print.add(params.detail, 'depth', 0, 0.8, 0.01).name('ridge depth');
  print.add(params.detail, 'period', 2.5, 7, 0.1).name('ridge period');
  print.add(params.detail, 'fadeTau', 0.2, 4, 0.05).name('ridge fade (s)');
  print.add(params.detail, 'smoothing', 0, 1.8, 0.05).name('ridge leveling');
  print.add(params.detail, 'hazeTau', 0.2, 4, 0.05).name('smudge fade (s)');

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

  gui.add({ drop: hooks.replayDrop }, 'drop').name('Drop it again');
  gui.add({ tap: hooks.tap }, 'tap').name('Tap the middle');

  if (matchMedia('(max-width: 600px)').matches) gui.close();
  return gui;
}
