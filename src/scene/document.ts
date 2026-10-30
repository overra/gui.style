// The authored scene, shared by the editor and text clients. Runtime resources and the orbit view stay outside
// this document. Version 1 describes the single page and goo element supported by the current renderer.

import { bindMaterial, createDefaultMaterial, type Material } from '../materials.ts';
import { defaultScene, type Scene, type SceneLight } from './scene.ts';
import type { Vec3 } from './math.ts';

export interface SceneDocument {
  version: 1;
  id: string;
  camera: { id: string; distance: number };
  gravity: Vec3;
  pages: {
    id: string;
    layers: { id: string; kind: 'art'; depth: number; fill: boolean; lit: number }[];
    elements: { id: string; kind: 'goo'; material: string; hover: number }[];
  }[];
  lights: SceneLight[];
  materials: Material[];
  probes: boolean;
}

export interface SceneIssue { path: string; message: string }
export interface SceneEdit { id: string; changes: Record<string, unknown> }
export interface SceneChange { revision: number; source: string; structural: boolean }

export class SceneDocumentError extends Error {
  readonly issues: SceneIssue[];
  constructor(issues: SceneIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.issues = issues;
    this.name = 'SceneDocumentError';
  }
}

export function createSceneDocument(): SceneDocument {
  const scene = defaultScene();
  const material = createDefaultMaterial();
  return {
    version: 1,
    id: 'main',
    camera: { id: 'camera', ...scene.camera },
    gravity: scene.gravity,
    pages: [{
      id: 'page',
      layers: [{ id: 'page-art', kind: 'art', ...scene.page }],
      elements: [{ id: 'goo', kind: 'goo', material: material.id, ...scene.goo }],
    }],
    lights: scene.lights,
    materials: [material],
    probes: scene.probes,
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Validate before changing live objects or allocating GPU resources. Unknown fields are errors, not lost data. */
export function validateSceneDocument(value: unknown): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const issue = (path: string, message: string) => { issues.push({ path, message }); };
  const template = createSceneDocument();
  function check(actual: unknown, expected: unknown, path: string): void {
    if (typeof expected === 'number') {
      if (typeof actual !== 'number' || !Number.isFinite(actual)) { issue(path, 'expected a finite number'); return; }
      if (!Number.isFinite(Math.fround(actual)) || Math.abs(actual) > 1e8) issue(path, 'outside the supported scene range');
      if ((path.includes('.params.') || path.includes('.optics.') || /\.(distance|refDistance|radius|round|soft|depth|hover|lit)$/.test(path)) && actual < 0)
        issue(path, 'must be nonnegative');
      if (/\.(distance|refDistance)$/.test(path) && actual <= 0) issue(path, 'must be positive');
      if (/\.(hover)$/.test(path) && actual > 150) issue(path, 'must be at most 150');
      if (/\.depth$/.test(path) && actual > 4000) issue(path, 'must be at most 4000');
      if (/\.lit$/.test(path) && actual > 1) issue(path, 'must be between 0 and 1');
      if (/\.params\.(feel|material)\./.test(path) && actual > 1) issue(path, 'must be between 0 and 1');
      if (/\.params\.(shape\.(plateau|bezel|steepness|blend)|heal\.(tau|ramp|zone)|detail\.(period|stampTau|fadeTau|hazeTau)|finger\.(pressTau|creepTau|capZ))$/.test(path) && actual <= 0)
        issue(path, 'must be positive');
      if (/\.params\.sim\.cell$/.test(path) && (actual < 1 || actual > 16)) issue(path, 'must be between 1 and 16');
      if (/\.params\.detail\.texel$/.test(path) && (actual < 0.25 || actual > 4)) issue(path, 'must be between 0.25 and 4');
      if (/\.params\.intro\.shrink$/.test(path) && (actual <= 0 || actual > 1)) issue(path, 'must be greater than 0 and at most 1');
      if (/\.params\.pixelBudget\./.test(path) && (actual < 10000 || actual > 4e6)) issue(path, 'must be between 10000 and 4000000');
      if (/\.params\.sim\.substep$/.test(path) && (actual < 1 / 2000 || actual > 1 / 60)) issue(path, 'must be between 1/2000 and 1/60');
      if (/\.params\.sim\.maxSubsteps$/.test(path) && (!Number.isInteger(actual) || actual < 1 || actual > 64)) issue(path, 'must be an integer between 1 and 64');
      if (/\.optics\.(light|dark)\.ior[RGB]$/.test(path) && (actual < 1 || actual > 3)) issue(path, 'must be between 1 and 3');
      return;
    }
    if (typeof expected === 'string' || typeof expected === 'boolean') {
      if (typeof actual !== typeof expected) issue(path, `expected ${typeof expected}`);
      else if (typeof actual === 'string' && (actual.length === 0 || actual.length > 200)) issue(path, 'expected 1–200 characters');
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) { issue(path, 'expected an array'); return; }
      const variable = path === 'scene.lights' || path === 'scene.materials';
      const max = path === 'scene.lights' ? 4 : 32;
      if (variable ? actual.length < 1 || actual.length > max : actual.length !== expected.length)
        issue(path, variable ? `expected 1–${max} entries` : `expected ${expected.length} entries in version 1`);
      actual.forEach((item, i) => check(item, expected[variable ? 0 : i] ?? expected[0], `${path}[${i}]`));
      return;
    }
    if (!record(actual) || !record(expected)) { issue(path, 'expected an object'); return; }
    for (const key of Object.keys(actual)) if (forbidden.has(key) || !(key in expected)) issue(`${path}.${key}`, 'unknown field');
    for (const [key, child] of Object.entries(expected)) check(actual[key], child, `${path}.${key}`);
  }
  check(value, template, 'scene');
  if (!record(value)) return issues;
  if (value.version !== 1) issue('scene.version', 'unsupported version; expected 1');
  const ids = new Set<string>();
  function nodes(item: unknown, path: string) {
    if (Array.isArray(item)) { item.forEach((v, i) => nodes(v, `${path}[${i}]`)); return; }
    if (!record(item)) return;
    if (typeof item.id === 'string') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(item.id)) issue(`${path}.id`, 'use 1–100 letters, digits, underscores or hyphens');
      if (ids.has(item.id)) issue(`${path}.id`, `duplicate id '${item.id}'`);
      ids.add(item.id);
    }
    for (const [key, child] of Object.entries(item)) nodes(child, `${path}.${key}`);
  }
  nodes(value, 'scene');
  const doc = value as unknown as SceneDocument;
  if (Array.isArray(doc.pages)) for (const [i, page] of doc.pages.entries()) {
    if (Array.isArray(page?.layers)) for (const layer of page.layers) if (layer?.kind !== 'art') issue(`scene.pages[${i}].layers`, 'version 1 supports art layers');
    if (Array.isArray(page?.elements)) for (const element of page.elements) {
      if (element?.kind !== 'goo') issue(`scene.pages[${i}].elements`, 'version 1 supports goo elements');
      if (!Array.isArray(doc.materials) || !doc.materials.some((m) => m?.id === element?.material)) issue(`scene.pages[${i}].elements`, 'material reference does not exist');
    }
  }
  if (Array.isArray(doc.lights)) {
    if (doc.lights.filter((l) => l?.kind === 'sun').length !== 1) issue('scene.lights', 'version 1 requires one sun');
    if (doc.lights.filter((l) => l?.kind === 'softbox').length > 3) issue('scene.lights', 'version 1 supports at most three softboxes');
    for (const [i, light] of doc.lights.entries()) {
      if (light?.kind !== 'sun' && light?.kind !== 'softbox') issue(`scene.lights[${i}].kind`, 'expected sun or softbox');
      for (const key of ['dir', 't', 'b'] as const) if (Array.isArray(light?.[key]) && Math.hypot(...light[key]) < 1e-8) issue(`scene.lights[${i}].${key}`, 'direction must be nonzero');
    }
  }
  return issues;
}

/** No older file format was shipped. Future migrations enter here before version-specific validation. */
export function readSceneDocument(input: unknown): SceneDocument {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); }
    catch { throw new SceneDocumentError([{ path: 'scene', message: 'invalid JSON' }]); }
  }
  const issues = validateSceneDocument(value);
  if (issues.length) throw new SceneDocumentError(issues);
  return structuredClone(value) as SceneDocument;
}

/** Preserve the live objects used by controls, including tuples and the single page's layer and element. */
function reconcile(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, next] of Object.entries(source)) {
    const previous = target[key];
    if (Array.isArray(previous) && Array.isArray(next)) {
      const pool = [...previous];
      const used = new Set<unknown>();
      const incomingIds = new Set(next.filter(record).map((item) => item.id));
      const items = next.map((item, i) => {
        if (record(item)) {
          const fallback = pool[i];
          const old = pool.find((candidate) => !used.has(candidate) && record(candidate) && candidate.id === item.id)
            ?? (!used.has(fallback) && record(fallback) && !incomingIds.has(fallback.id) ? fallback : undefined);
          if (record(old)) { used.add(old); reconcile(old, item); return old; }
        }
        return structuredClone(item);
      });
      previous.splice(0, previous.length, ...items);
    } else if (record(previous) && record(next)) reconcile(previous, next);
    else target[key] = structuredClone(next);
  }
}

function structuralKey(doc: SceneDocument): string {
  const material = doc.materials.find((m) => m.id === doc.pages[0].elements[0].material)!;
  const p = material.params;
  return JSON.stringify([material.id, p.shape, p.sim.cell, p.detail.texel, p.intro.shrink, p.pixelBudget]);
}

export function createSceneStore(initial: SceneDocument, notify: (change: SceneChange) => void) {
  const document = readSceneDocument(initial);
  let revision = 0;
  let saved = false;
  let storageError = '';
  const storageKey = 'gui.style.scene.v1';
  const undo: SceneDocument[] = [];
  const redo: SceneDocument[] = [];
  let group: SceneDocument | null = null;

  function bind() {
    const index = document.materials.findIndex((m) => m.id === document.pages[0].elements[0].material);
    document.materials[index] = bindMaterial(document.materials[index]);
  }
  bind();
  let accepted = structuredClone(document);

  function adopt(next: SceneDocument) {
    // Material records are copied before the stable active instance is rebound, so switching cannot overwrite
    // the material that was previously active. Page objects remain in place for existing GUI controllers.
    const materials = structuredClone(next.materials);
    reconcile(document as unknown as Record<string, unknown>, { ...next, materials: [] });
    document.materials.splice(0, document.materials.length, ...materials);
    bind();
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(document)); saved = true; storageError = ''; }
    catch (error) { saved = false; storageError = error instanceof Error ? error.message : String(error); }
    return saved;
  }
  function publish(next: SceneDocument, source: string, history = true) {
    if (JSON.stringify(next) === JSON.stringify(accepted)) return revision;
    const structural = structuralKey(next) !== structuralKey(accepted);
    if (history && !group) { undo.push(accepted); if (undo.length > 100) undo.shift(); }
    if (history) redo.length = 0;
    adopt(next);
    accepted = structuredClone(document);
    revision++;
    save();
    notify({ revision, source, structural });
    return revision;
  }
  function changed(source = 'editor') {
    try { return publish(readSceneDocument(document), source); }
    catch (error) { adopt(accepted); throw error; }
  }
  function end() {
    if (group && JSON.stringify(group) !== JSON.stringify(accepted)) {
      undo.push(group);
      if (undo.length > 100) undo.shift();
    }
    group = null;
  }
  function find(id: string, value: unknown = document): Record<string, unknown> | null {
    if (Array.isArray(value)) {
      for (const item of value) { const match = find(id, item); if (match) return match; }
    } else if (record(value)) {
      if (value.id === id) return value;
      for (const item of Object.values(value)) { const match = find(id, item); if (match) return match; }
    }
    return null;
  }
  function merge(target: Record<string, unknown>, patch: Record<string, unknown>, path: string) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'version' || forbidden.has(key) || !Object.hasOwn(target, key))
        throw new SceneDocumentError([{ path: `${path}.${key}`, message: 'field cannot be edited here' }]);
      if (record(value) && record(target[key])) merge(target[key], value, `${path}.${key}`);
      else target[key] = structuredClone(value);
    }
  }
  const scene: Scene = {
    get camera() { return document.camera; },
    get page() { return document.pages[0].layers[0]; },
    get goo() { return document.pages[0].elements[0]; },
    get lights() { return document.lights; },
    get gravity() { return document.gravity; },
    get probes() { return document.probes; },
    set probes(value) { document.probes = value; },
  };
  const api = {
    export: () => structuredClone(document),
    validate: (input: unknown) => { try { readSceneDocument(input); return []; } catch (error) { return error instanceof SceneDocumentError ? error.issues : [{ path: 'scene', message: String(error) }]; } },
    load(input: unknown) { const next = readSceneDocument(input); end(); return publish(next, 'load'); },
    edit(edits: SceneEdit | SceneEdit[], options: { expectedRevision?: number } = {}) {
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision)
        throw new SceneDocumentError([{ path: 'revision', message: `expected ${options.expectedRevision}, current revision is ${revision}` }]);
      const next = structuredClone(accepted);
      for (const edit of Array.isArray(edits) ? edits : [edits]) {
        if (!record(edit) || typeof edit.id !== 'string' || !record(edit.changes))
          throw new SceneDocumentError([{ path: 'edit', message: 'expected { id, changes }' }]);
        const node = find(edit.id, next);
        if (!node) throw new SceneDocumentError([{ path: edit.id, message: 'unknown node id' }]);
        merge(node, edit.changes, edit.id);
      }
      const validated = readSceneDocument(next);
      end();
      return publish(validated, 'agent');
    },
    undo() { end(); const previous = undo.pop(); if (!previous) return revision; redo.push(accepted); return publish(previous, 'undo', false); },
    redo() { end(); const next = redo.pop(); if (!next) return revision; undo.push(accepted); return publish(next, 'redo', false); },
    save,
    clearSaved() { try { localStorage.removeItem(storageKey); saved = false; storageError = ''; } catch (error) { storageError = String(error); } },
    get revision() { return revision; },
    get saved() { return saved; },
    get storageError() { return storageError; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
  };
  return {
    document, scene, api, changed,
    get material() { return document.materials.find((m) => m.id === document.pages[0].elements[0].material)!; },
    begin() { group ??= structuredClone(accepted); },
    end,
    /** Finish one-time default light placement before the first export or edit, without adding history. */
    initialize() { accepted = structuredClone(document); },
    restore() {
      try {
        const text = localStorage.getItem(storageKey);
        if (!text) return false;
        adopt(readSceneDocument(text));
        accepted = structuredClone(document);
        saved = true;
        return true;
      } catch (error) { storageError = error instanceof Error ? error.message : String(error); return false; }
    },
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;
