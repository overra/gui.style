// The putty's material and the scene's gravity as lil-gui folders, shared by the tuning panel (?tune) and the 3D
// view's panel. Both edit the same objects (params.material, and scene.gravity in place), so each follows the other.

import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { params } from './params.ts';
import { clamp, DEG, type Vec3 } from './scene/math.ts';

export interface MaterialHooks {
  /** scene.gravity (world frame, in g), edited in place. */
  gravity: Vec3;
  /** The sag check under the current gravity and material, and the settle layer's phase (null before the GPU). */
  sag: () => { regime: string; phase: string } | null;
}

/** Directions (unit vectors); picking one keeps the strength. */
const GRAVITY: Record<string, Vec3> = {
  'down the page': [0, 1, 0],
  'into the page (a floor)': [0, 0, -1],
  'out of the page (a ceiling)': [0, 0, 1],
};

/**
 * The direction as angles, per gravity vector, shared by every folder that edits it (both panels, and the 3D
 * view's panel rebuilt on each visit). Degrees: along the page as atan2(y_down, x) (90 = down the screen), and into
 * the page (+90 = a floor). They are kept while the strength is 0, so turning it back up keeps the direction.
 */
const remembered = new WeakMap<Vec3, { along: number; into: number }>();

/** What the material does under the current gravity: "holds", "sags (settling)" and so on. */
function stateText(hooks: MaterialHooks) {
  const s = hooks.sag();
  if (!s) return '–';
  if (s.phase === 'settling') return `${s.regime} (settling)`;
  return s.phase === 'remolding' ? `${s.regime} (re-molding)` : s.regime;
}

/** Adhesion, cohesion, surface tension and density (0.5 = the base values), and what the putty does under gravity. */
export function addMaterialFolder(gui: GUI, hooks: MaterialHooks): { folder: GUI; live: Controller[] } {
  const folder = gui.addFolder('Material');
  const m = params.material;
  const live = [
    folder.add(m, 'adhesion', 0, 1, 0.01).name('adhesion (slips → sticks)'),
    folder.add(m, 'cohesion', 0, 1, 0.01).name('cohesion (runny → holds)'),
    folder.add(m, 'surfaceTension', 0, 1, 0.01).name('surface tension (wrinkly → smooth)'),
    folder.add(m, 'density', 0, 1, 0.01).name('density (light → heavy)'),
    folder
      .add(
        {
          get state() {
            return stateText(hooks);
          },
        },
        'state',
      )
      .name('under gravity')
      .disable(),
  ];
  return { folder, live };
}

/** Global gravity: a direction preset, the strength, and its angles along and into the page. */
export function addGravityFolder(gui: GUI, hooks: MaterialHooks): { folder: GUI; live: Controller[] } {
  const g = hooks.gravity;
  let angles = remembered.get(g);
  if (!angles) remembered.set(g, (angles = { along: 90, into: 0 }));
  const a = angles;
  const strength = () => Math.hypot(g[0], g[1], g[2]);
  const read = () => {
    const s = strength();
    if (s < 1e-9) return;
    a.into = Math.asin(clamp(-g[2] / s, -1, 1)) / DEG;
    if (Math.hypot(g[0], g[1]) > 1e-9 * s) a.along = Math.atan2(g[1], g[0]) / DEG;
  };
  const write = (s: number) => {
    const t = a.along * DEG;
    const p = a.into * DEG;
    g.splice(0, 3, s * Math.cos(p) * Math.cos(t), s * Math.cos(p) * Math.sin(t), -s * Math.sin(p));
  };
  const proxy = {
    get preset() {
      const s = strength();
      if (s < 1e-9) return 'weightless';
      const hit = Object.entries(GRAVITY).find(([, v]) => v.every((c, i) => Math.abs(c - g[i] / s) < 1e-6));
      return hit ? hit[0] : 'custom';
    },
    set preset(name: string) {
      read();
      if (name === 'weightless') {
        g.splice(0, 3, 0, 0, 0);
        return;
      }
      const v = GRAVITY[name];
      if (!v) return;
      // Keep the strength (1 g from weightless).
      const s = strength();
      const k = s > 1e-9 ? s : 1;
      g.splice(0, 3, v[0] * k, v[1] * k, v[2] * k);
    },
    get strength() {
      return strength();
    },
    set strength(s: number) {
      read();
      write(s);
    },
    get along() {
      read();
      return a.along;
    },
    set along(v: number) {
      const s = strength();
      read();
      a.along = v;
      write(s);
    },
    get into() {
      read();
      return a.into;
    },
    set into(v: number) {
      const s = strength();
      read();
      a.into = v;
      write(s);
    },
  };
  const folder = gui.addFolder('Gravity');
  const live = [
    folder.add(proxy, 'preset', [...Object.keys(GRAVITY), 'weightless', 'custom']).name('direction'),
    folder.add(proxy, 'strength', 0, 4, 0.05).name('strength (g)'),
    folder.add(proxy, 'along', -180, 180, 1).name('along the page (°, 90 = down)'),
    folder.add(proxy, 'into', -90, 90, 1).name('into the page (°)'),
  ];
  return { folder, live };
}
