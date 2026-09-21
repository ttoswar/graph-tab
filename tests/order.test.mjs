import test from 'node:test';
import assert from 'node:assert/strict';
import { chronoIndex, orderCommits } from '../src/order.js';

const DATES = ['2026-01-01', '2026-01-01', '2026-01-03', '2026-01-05'];
test('chronoIndex places a date between the network array entries', () => {
  // 2026-01-02 is after both 01-01 entries (indices 0 and 1) and before 01-03
  const mid = chronoIndex(DATES, new Date(2026, 0, 2, 12, 0, 0));
  assert.ok(mid > 1 && mid < 2, `expected (1, 2), got ${mid}`);
});

test('chronoIndex puts a commit newer than the whole array above its last entry', () => {
  const newer = chronoIndex(DATES, new Date(2026, 5, 1, 12, 0, 0));
  assert.ok(newer > DATES.length - 1, `expected > 3, got ${newer}`);
});

test('chronoIndex puts a commit older than the whole array below index 0', () => {
  assert.ok(chronoIndex(DATES, new Date(2020, 0, 1, 0, 0, 0)) < 0);
});

test('chronoIndex orders same-day commits by their time of day', () => {
  // Local-time constructors: the day axis and the fraction are both local.
  const morning = chronoIndex(DATES, new Date(2026, 0, 3, 1, 0, 0));
  const evening = chronoIndex(DATES, new Date(2026, 0, 3, 23, 0, 0));
  assert.ok(evening > morning, `${evening} should exceed ${morning}`);
  assert.ok(morning >= 1 && evening < 3, 'both stay inside the 2026-01-03 slot');
});

test('chronoIndex tolerates a missing date', () => {
  assert.equal(Number.isFinite(chronoIndex(DATES, null)), true);
});

test('orderCommits sorts newest-first by idx', () => {
  const commits = [
    { oid: 'a', parents: [], idx: 1 },
    { oid: 'c', parents: [], idx: 3 },
    { oid: 'b', parents: [], idx: 2 },
  ];
  assert.deepEqual(orderCommits(commits).map((c) => c.oid), ['c', 'b', 'a']);
});

test('a parent never precedes its child, even with a newer date', () => {
  // `child` is dated before its own parent (clock skew / a rebase); idx alone
  // would emit the parent first and break the lane layout.
  const commits = [
    { oid: 'child', parents: ['parent'], idx: 1 },
    { oid: 'parent', parents: [], idx: 5 },
  ];
  assert.deepEqual(orderCommits(commits).map((c) => c.oid), ['child', 'parent']);
});

test('a merge is emitted before both of its parents', () => {
  const commits = [
    { oid: 'side', parents: ['base'], idx: 2 },
    { oid: 'merge', parents: ['main', 'side'], idx: 4 },
    { oid: 'main', parents: ['base'], idx: 3 },
    { oid: 'base', parents: [], idx: 1 },
  ];
  const order = orderCommits(commits).map((c) => c.oid);
  assert.deepEqual(order, ['merge', 'main', 'side', 'base']);
});

test('disconnected histories interleave by idx', () => {
  // Two roots that share nothing: a graph tool shows both, ordered by date.
  const commits = [
    { oid: 'x2', parents: ['x1'], idx: 10 },
    { oid: 'x1', parents: [], idx: 4 },
    { oid: 'y2', parents: ['y1'], idx: 8 },
    { oid: 'y1', parents: [], idx: 6 },
  ];
  assert.deepEqual(orderCommits(commits).map((c) => c.oid), ['x2', 'y2', 'y1', 'x1']);
});

test('parents outside the set do not stall the walk', () => {
  const commits = [{ oid: 'tip', parents: ['gone'], idx: 1 }];
  assert.deepEqual(orderCommits(commits).map((c) => c.oid), ['tip']);
});

test('a cycle still emits every row', () => {
  const commits = [
    { oid: 'a', parents: ['b'], idx: 2 },
    { oid: 'b', parents: ['a'], idx: 1 },
  ];
  assert.deepEqual(orderCommits(commits).map((c) => c.oid).sort(), ['a', 'b']);
});

test('empty input', () => {
  assert.deepEqual(orderCommits([]), []);
});
