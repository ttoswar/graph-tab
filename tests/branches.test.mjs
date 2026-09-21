import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSelection, saveSelection, resolveSelection } from '../src/branches.js';

const BRANCHES = [
  { name: 'main', oid: 'a' },
  { name: 'develop', oid: 'b' },
  { name: 'release/1.x', oid: 'c' },
];
const loadedOnly = (...oids) => (oid) => oids.includes(oid);

test('the automatic default is the loaded branches plus the default branch', () => {
  const selected = resolveSelection(null, BRANCHES, 'release/1.x', loadedOnly('a'));
  assert.deepEqual([...selected].sort(), ['main', 'release/1.x']);
});

test('the default branch is included even when its tip is outside the window', () => {
  const selected = resolveSelection(null, BRANCHES, 'develop', loadedOnly());
  assert.deepEqual([...selected], ['develop']);
});

test('every branch is shown when none of them is loaded and there is no default', () => {
  // Better a graph of stubs than an empty box.
  const selected = resolveSelection(null, BRANCHES, '', loadedOnly());
  assert.deepEqual([...selected].sort(), ['develop', 'main', 'release/1.x']);
});

test('a stored choice wins over the automatic default, plus the default branch', () => {
  const selected = resolveSelection(['develop'], BRANCHES, 'main', loadedOnly('a'));
  assert.deepEqual([...selected].sort(), ['develop', 'main']);
});

test("the default branch is drawn even when its tip is outside the window", () => {
  const selected = resolveSelection(['develop'], BRANCHES, 'main', loadedOnly());
  assert.ok(selected.has('main'));
});

test('branches deleted since the choice was made are dropped', () => {
  const selected = resolveSelection(['develop', 'gone'], BRANCHES, 'main', loadedOnly('a'));
  assert.deepEqual([...selected].sort(), ['develop', 'main']);
});

test('a stored choice whose branches are all gone falls back to automatic', () => {
  const selected = resolveSelection(['gone'], BRANCHES, 'main', loadedOnly('a'));
  assert.deepEqual([...selected], ['main']);
});

test('selections round-trip per repository and reset to automatic', () => {
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
  };
  try {
    assert.equal(loadSelection('o', 'r'), null);
    saveSelection('o', 'r', ['main', 'develop']);
    saveSelection('o', 'other', ['x']);
    assert.deepEqual(loadSelection('o', 'r'), ['main', 'develop']);
    assert.deepEqual(loadSelection('o', 'other'), ['x']);
    saveSelection('o', 'r', null);
    assert.equal(loadSelection('o', 'r'), null);
    assert.deepEqual(loadSelection('o', 'other'), ['x']);
  } finally {
    delete globalThis.localStorage;
  }
});

test('storage that throws does not take the graph down', () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  try {
    assert.equal(loadSelection('o', 'r'), null);
    assert.doesNotThrow(() => saveSelection('o', 'r', ['main']));
  } finally {
    delete globalThis.localStorage;
  }
});
