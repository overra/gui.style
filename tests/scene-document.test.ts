import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { looks } from '../src/look.ts';
import { createDefaultMaterial } from '../src/materials.ts';
import { params } from '../src/params.ts';
import {
  createSceneDocument,
  createSceneStore,
  readSceneDocument,
  SceneDocumentError,
  type SceneChange,
} from '../src/scene/document.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});

const setup = (initial = createSceneDocument()) => {
  const changes: SceneChange[] = [];
  const store = createSceneStore(initial, (change) => changes.push(change));
  return { store, changes };
};

test('JSON round-trip preserves authored values and exports independent copies', () => {
  const { store, changes } = setup();
  const original = store.api.export();
  assert.deepEqual(readSceneDocument(JSON.stringify(original)), original);
  assert.equal(store.api.load(JSON.stringify(original)), 0);
  assert.equal(changes.length, 0);
  const exported = store.api.export();
  exported.camera.distance = 999;
  exported.materials[0].params.feel.viscosity = 0.9;
  assert.deepEqual(store.api.export(), original);
});

test('an edit batch targets stable ids, commits once and leaves other values unchanged', () => {
  const { store, changes } = setup();
  const before = store.api.export();
  const light = before.lights[1];
  const position = [light.position[0] + 50, light.position[1] - 10, light.position[2]];
  assert.equal(store.api.edit([
    { id: before.camera.id, changes: { distance: 1500 } },
    { id: light.id, changes: { position } },
    { id: before.materials[0].id, changes: { params: { feel: { viscosity: 0.75 } } } },
  ]), 1);
  const expected = structuredClone(before);
  expected.camera.distance = 1500;
  expected.lights[1].position = position as [number, number, number];
  expected.materials[0].params.feel.viscosity = 0.75;
  assert.deepEqual(store.api.export(), expected);
  assert.deepEqual(changes, [{ revision: 1, source: 'agent', structural: false }]);
  assert.equal(store.api.saved, true);
});

test('a rejected edit batch never commits its valid prefix', () => {
  const { store, changes } = setup();
  const before = store.api.export();
  for (const badEdit of [
    { id: 'missing', changes: { distance: 999 } },
    { id: 'goo', changes: { material: 'missing' } },
    { id: 'camera', changes: { distance: NaN } },
    { id: 'camera', changes: { unexpected: 1 } },
    { id: 'camera', changes: { id: 'replacement' } },
  ]) {
    assert.throws(() => store.api.edit([
      { id: 'camera', changes: { distance: 1500 } },
      badEdit,
    ]), SceneDocumentError);
    assert.deepEqual(store.api.export(), before);
    assert.equal(store.api.revision, 0);
    assert.equal(store.api.canUndo, false);
    assert.equal(changes.length, 0);
    assert.equal(storage.values.size, 0);
  }
});

test('unsupported versions, duplicate ids, missing references and extra fields are rejected before load', () => {
  const { store } = setup();
  const before = store.api.export();
  const invalid: unknown[] = [null, [], '{bad json'];
  const version = structuredClone(before) as unknown as { version: number };
  version.version = 2;
  invalid.push(version);
  const duplicate = structuredClone(before);
  duplicate.lights[0].id = duplicate.camera.id;
  invalid.push(duplicate);
  const missing = structuredClone(before);
  missing.pages[0].elements[0].material = 'absent';
  invalid.push(missing);
  const extra = { ...structuredClone(before), custom: 'unrecognized' };
  invalid.push(extra);
  const wrongTuple = structuredClone(before) as unknown as { gravity: number[] };
  wrongTuple.gravity = [0, 1];
  invalid.push(wrongTuple);
  for (const [section, field, value] of [
    ['shape', 'plateau', 0], ['sim', 'substep', 0], ['sim', 'maxSubsteps', 1.5], ['detail', 'texel', 0],
  ] as const) {
    const badPhysics = structuredClone(before);
    Reflect.set(badPhysics.materials[0].params[section], field, value);
    invalid.push(badPhysics);
  }
  invalid.push(JSON.parse(JSON.stringify(before).replace('"version":1', '"__proto__":{"polluted":true},"version":1')));
  for (const value of invalid) {
    assert.ok(store.api.validate(value).length > 0);
    assert.throws(() => store.api.load(value), SceneDocumentError);
    assert.deepEqual(store.api.export(), before);
    assert.equal(store.api.revision, 0);
  }
});

test('optimistic revision checks reject stale edits without mutation', () => {
  const { store } = setup();
  store.api.edit({ id: 'camera', changes: { distance: 1500 } }, { expectedRevision: 0 });
  const accepted = store.api.export();
  assert.throws(() => store.api.edit({ id: 'camera', changes: { distance: 1700 } }, { expectedRevision: 0 }), SceneDocumentError);
  assert.deepEqual(store.api.export(), accepted);
  assert.equal(store.api.revision, 1);
});

test('undo and redo restore whole edits, and a new edit clears redo', () => {
  const { store } = setup();
  const initial = store.api.export();
  store.api.edit({ id: 'camera', changes: { distance: 1500 } });
  const first = store.api.export();
  store.api.edit({ id: 'goo', changes: { hover: 40 } });
  const second = store.api.export();
  store.api.undo();
  assert.deepEqual(store.api.export(), first);
  store.api.undo();
  assert.deepEqual(store.api.export(), initial);
  assert.equal(store.api.canUndo, false);
  store.api.redo();
  assert.deepEqual(store.api.export(), first);
  store.api.redo();
  assert.deepEqual(store.api.export(), second);
  store.api.undo();
  store.api.edit({ id: 'goo', changes: { hover: 20 } });
  assert.equal(store.api.canRedo, false);
});

test('editor mutations share the edit history and retain GUI-held objects', () => {
  const { store } = setup();
  const page = store.scene.page;
  const gravity = store.scene.gravity;
  const feel = params.feel;
  const initial = store.api.export();
  store.begin();
  page.depth = 20;
  store.changed();
  page.depth = 40;
  gravity[0] = 0.25;
  feel.viscosity = 0.8;
  store.changed();
  store.end();
  assert.equal(store.api.revision, 2);
  assert.equal(store.api.canUndo, true);
  store.api.undo();
  assert.deepEqual(store.api.export(), initial);
  assert.equal(store.api.canUndo, false);
  assert.equal(store.scene.page, page);
  assert.equal(store.scene.gravity, gravity);
  assert.equal(params.feel, feel);
});

test('invalid editor mutations are rolled back before notification or history', () => {
  const { store, changes } = setup();
  const initial = store.api.export();
  const page = store.scene.page;
  page.depth = -1;
  assert.throws(() => store.changed(), SceneDocumentError);
  assert.equal(store.scene.page, page);
  assert.deepEqual(store.api.export(), initial);
  assert.equal(store.api.revision, 0);
  assert.equal(changes.length, 0);
});

test('switching materials preserves inactive values and stable active GUI references', () => {
  const initial = createSceneDocument();
  const other = createDefaultMaterial('second-material');
  other.params.feel.viscosity = 0.9;
  other.optics.light.roughness = 0.4;
  initial.materials.push(other);
  const { store } = setup(initial);
  const feel = params.feel;
  const look = looks.light;
  store.api.edit({ id: 'glass-putty', changes: { params: { feel: { viscosity: 0.2 } }, optics: { light: { roughness: 0.1 } } } });
  store.api.edit({ id: 'goo', changes: { material: other.id } });
  assert.equal(params.feel, feel);
  assert.equal(looks.light, look);
  assert.equal(feel.viscosity, 0.9);
  assert.equal(look.roughness, 0.4);
  const inactive = store.api.export().materials.find((m) => m.id === 'glass-putty')!;
  assert.equal(inactive.params.feel.viscosity, 0.2);
  assert.equal(inactive.optics.light.roughness, 0.1);
  look.roughness = 0.3;
  store.changed();
  store.api.edit({ id: 'goo', changes: { material: 'glass-putty' } });
  assert.equal(feel.viscosity, 0.2);
  assert.equal(look.roughness, 0.1);
  assert.equal(store.api.export().materials.find((m) => m.id === other.id)!.optics.light.roughness, 0.3);
});

test('world light positions survive page, camera and element edits', () => {
  const { store } = setup();
  const lights = store.api.export().lights;
  store.api.edit([
    { id: 'camera', changes: { distance: 1600 } },
    { id: 'page-art', changes: { depth: 200 } },
    { id: 'goo', changes: { hover: 80 } },
  ]);
  assert.deepEqual(store.api.export().lights, lights);
});

test('edits that change precomputed geometry request a structural rebuild', () => {
  for (const patch of [
    { shape: { plateau: 22 } },
    { sim: { cell: 4 } },
    { detail: { texel: 1 } },
    { intro: { shrink: 0.7 } },
  ]) {
    const { store, changes } = setup();
    store.api.edit({ id: 'glass-putty', changes: { params: patch } });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].structural, true, JSON.stringify(patch));
  }
});

test('import can reorder, add and remove light nodes without aliasing their identities', () => {
  const { store } = setup();
  const sun = store.scene.lights[0];
  const front = store.scene.lights[1];
  const incoming = store.api.export();
  const added = structuredClone(incoming.lights[1]);
  added.id = 'new-softbox';
  added.name = 'Added softbox';
  incoming.lights = [incoming.lights[1], added, incoming.lights[0]];
  store.api.load(incoming);
  assert.deepEqual(store.api.export(), incoming);
  assert.equal(store.scene.lights[0], front);
  assert.equal(store.scene.lights[2], sun);
  assert.notEqual(store.scene.lights[0], store.scene.lights[1]);
  assert.notEqual(store.scene.lights[1], store.scene.lights[2]);
  store.scene.lights[0].name = 'Front edited';
  store.changed();
  assert.equal(store.api.export().lights[1].name, 'Added softbox');
  store.api.undo();
  assert.deepEqual(store.api.export(), incoming);
  store.api.undo();
  assert.equal(store.api.export().lights.length, 4);
});

test('an inserted light never takes the live object of a surviving later light', () => {
  const { store } = setup();
  const sun = store.scene.lights[0];
  const front = store.scene.lights[1];
  const incoming = store.api.export();
  const added = structuredClone(incoming.lights[1]);
  added.id = 'new-softbox';
  incoming.lights = [added, incoming.lights[1], incoming.lights[0]];
  store.api.load(incoming);
  assert.deepEqual(store.api.export(), incoming);
  assert.equal(store.scene.lights[1], front);
  assert.equal(store.scene.lights[2], sun);
  assert.notEqual(store.scene.lights[0], sun);
});

test('saved documents restore from localStorage without adding history', () => {
  const { store } = setup();
  store.api.edit({ id: 'camera', changes: { distance: 1600 } });
  const saved = store.api.export();
  const { store: restored } = setup();
  assert.equal(restored.restore(), true);
  assert.deepEqual(restored.api.export(), saved);
  assert.equal(restored.api.saved, true);
  assert.equal(restored.api.revision, 0);
  assert.equal(restored.api.canUndo, false);
  restored.api.clearSaved();
  assert.equal(storage.values.size, 0);
  assert.equal(restored.api.saved, false);
});

test('an invalid saved document preserves the initial scene and reports the failure', () => {
  const invalid = { ...createSceneDocument(), version: 99 };
  storage.setItem('gui.style.scene.v1', JSON.stringify(invalid));
  const { store } = setup();
  const initial = store.api.export();
  assert.equal(store.restore(), false);
  assert.deepEqual(store.api.export(), initial);
  assert.match(store.api.storageError, /unsupported version/);
  assert.equal(store.api.saved, false);
});

test('storage failures do not prevent valid edits from being accepted', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem() { throw new Error('storage unavailable'); } },
  });
  const { store, changes } = setup();
  assert.equal(store.api.edit({ id: 'camera', changes: { distance: 1500 } }), 1);
  assert.equal(store.scene.camera.distance, 1500);
  assert.equal(changes.length, 1);
  assert.equal(store.api.saved, false);
  assert.equal(store.api.storageError, 'storage unavailable');
});
