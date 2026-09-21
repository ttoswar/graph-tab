// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/layout.js';

const c = (oid, ...parents) => ({ oid, parents });

test('linear history stays in one lane', () => {
  const g = layout([c('a', 'b'), c('b', 'c'), c('c')]);
  assert.deepEqual(g.nodes.map((n) => n.x), [0, 0, 0]);
  assert.deepEqual(g.nodes.map((n) => n.color), [0, 0, 0]);
  assert.equal(g.laneCount, 1);
  assert.ok(g.segments.every((s) => s.x1 === 0 && s.x2 === 0 && !s.dashed));
});

test('fork/merge diamond: side branch gets lane 1 and converges at the base', () => {
  // m merges a (main) and b (feature); both descend from base.
  const g = layout([c('m', 'a', 'b'), c('a', 'base'), c('b', 'base'), c('base')]);
  assert.deepEqual(g.nodes.map((n) => n.x), [0, 0, 1, 0]);
  assert.deepEqual(g.nodes.map((n) => n.color), [0, 0, 1, 0]);
  assert.equal(g.laneCount, 2);
  // merge edge leaves the merge node into lane 1
  assert.ok(g.segments.some((s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 1 && s.y2 === 1 && s.color === 1));
  // feature lane converges into the base node
  assert.ok(g.segments.some((s) => s.x1 === 1 && s.y1 === 2 && s.x2 === 0 && s.y2 === 3 && s.color === 1));
  assert.ok(g.segments.every((s) => !s.dashed));
});

test('octopus merge opens one lane per extra parent', () => {
  const g = layout([c('m', 'a', 'b', 'x'), c('a'), c('b'), c('x')]);
  assert.deepEqual(g.nodes.map((n) => n.x), [0, 0, 1, 2]);
  assert.equal(g.laneCount, 3);
  // both merge edges start at the node
  assert.ok(g.segments.some((s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 1 && s.y2 === 1));
  assert.ok(g.segments.some((s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 2 && s.y2 === 1));
});

test('merge into a branch that already has an open lane joins it', () => {
  // m2 merges b, which m1 (above it... below it) also targets: the second
  // reference joins the existing lane instead of opening a new one.
  const g = layout([
    c('m1', 'a', 'b'),
    c('m2', 'a2', 'b'),
    c('a', 'root'),
    c('a2', 'root'),
    c('b', 'root'),
    c('root'),
  ]);
  // b's lane is lane 1 (opened by m1); m2's merge edge joins it, so no third
  // lane is created for b.
  const bNode = g.nodes[4];
  assert.equal(bNode.x, 1);
  // join edge from m2's node (x=2? m2 is a tip -> lane 2) into lane 1
  const m2Node = g.nodes[1];
  assert.ok(
    g.segments.some((s) => s.x1 === m2Node.x && s.y1 === 1 && s.x2 === 1 && s.y2 === 2),
    'merge join segment missing',
  );
});

test('freed lanes are reused', () => {
  // Two independent roots: after the first chain ends its lane frees up.
  const g = layout([c('a', 'root1'), c('root1'), c('b', 'root2'), c('root2')]);
  assert.deepEqual(g.nodes.map((n) => n.x), [0, 0, 0, 0]);
  // but colors differ: separate branches
  assert.deepEqual(g.nodes.map((n) => n.color), [0, 0, 1, 1]);
});

test('long-lived side lane coalesces into one straight segment', () => {
  const g = layout([
    c('a', 'base'),
    c('b1', 'b2'),
    c('b2', 'b3'),
    c('b3', 'base'),
    c('base'),
  ]);
  // lane 0 passes rows 0..4 untouched except endpoints -> single vertical run
  const straight = g.segments.filter((s) => s.x1 === 0 && s.x2 === 0 && !s.dashed);
  assert.equal(straight.length, 1);
  assert.deepEqual([straight[0].y1, straight[0].y2], [0, 4]);
});

test('parents outside the window produce dashed tails', () => {
  const g = layout([c('a', 'missing')]);
  const tails = g.segments.filter((s) => s.dashed);
  assert.equal(tails.length, 1);
  assert.equal(tails[0].x1, 0);
  assert.ok(tails[0].y2 > tails[0].y1);
});

test('empty input', () => {
  const g = layout([]);
  assert.deepEqual(g, { nodes: [], segments: [], laneCount: 0 });
});

test('the pinned branch owns lane 0 even when another branch is newer', () => {
  // `topic` is the newest row, so without pinning it would take lane 0 and
  // the default branch would be pushed right.
  const commits = [
    { oid: 'topic', parents: ['base'] },
    { oid: 'main', parents: ['base'] },
    { oid: 'base', parents: [] },
  ];
  const plain = layout(commits);
  assert.deepEqual(plain.nodes.map((n) => n.x), [0, 1, 0]);

  const pinned = layout(commits, { pinnedOid: 'main' });
  assert.deepEqual(pinned.nodes.map((n) => n.x), [1, 0, 0]);
  // The reserved lane draws nothing above its own commit: no line may appear
  // in lane 0 on the `topic` row, which sits above `main`.
  const above = pinned.segments.filter((s) => s.y1 < 1 && (s.x1 === 0 || s.x2 === 0));
  assert.deepEqual(above, []);
});

test('lane 0 is not handed to another branch after the pinned history ends', () => {
  const commits = [
    { oid: 'main', parents: ['root'] },
    { oid: 'root', parents: [] },
    { oid: 'orphan', parents: [] }, // unrelated history below, no common base
  ];
  const { nodes } = layout(commits, { pinnedOid: 'main' });
  assert.deepEqual(nodes.map((n) => n.x), [0, 0, 1]);
});

test('an unknown pinned oid changes nothing', () => {
  const commits = [{ oid: 'a', parents: [] }];
  assert.deepEqual(
    layout(commits, { pinnedOid: 'nope' }).nodes,
    layout(commits).nodes,
  );
});

test('a merge into the pinned branch keeps its edge until the pinned row', () => {
  // feature merged main (P) in, then two more feature commits landed, so the
  // pinned tip P sits several rows below the merge M. The merge edge must
  // run all the way down into P, not stop one row under M.
  const commits = [
    { oid: 'M', parents: ['F2', 'P'] },
    { oid: 'F2', parents: ['F1'] },
    { oid: 'F1', parents: ['P0'] },
    { oid: 'P', parents: ['P0'] },
    { oid: 'P0', parents: [] },
  ];
  const g = layout(commits, { pinnedOid: 'P' });
  assert.deepEqual(g.nodes.map((n) => n.x), [1, 1, 1, 0, 0]);
  // Nothing may touch lane 0 above P's row (3): the reserved lane is silent.
  const above = g.segments.filter((s) => s.y2 <= 3 && s.y1 < 3 && (s.x1 === 0 || s.x2 === 0) && !(s.y2 === 3 && s.x2 === 0));
  assert.deepEqual(above, []);
  // The merge edge leaves M into a lane of its own and comes into P from it.
  const merge = g.segments.find((s) => s.y1 === 0 && s.x1 === 1 && s.x2 === 2);
  assert.ok(merge, 'merge edge should open its own lane');
  assert.ok(g.segments.some((s) => s.y2 === 3 && s.x2 === 0 && s.x1 === 2 && s.color === merge.color), 'merge lane must bend into P');
  // Every row between M and P is covered by that lane: no gap.
  for (let row = 1; row < 3; row++) {
    assert.ok(g.segments.some((s) => s.color === merge.color && s.y1 <= row && s.y2 >= row + 1), `merge lane missing at row ${row}`);
  }
});

test('two merges into the pinned branch share one lane', () => {
  const commits = [
    { oid: 'M2', parents: ['F3', 'P'] },
    { oid: 'F3', parents: ['M1'] },
    { oid: 'M1', parents: ['F1', 'P'] },
    { oid: 'F1', parents: ['P0'] },
    { oid: 'P', parents: ['P0'] },
    { oid: 'P0', parents: [] },
  ];
  const g = layout(commits, { pinnedOid: 'P' });
  assert.deepEqual(g.nodes.map((n) => n.x), [1, 1, 1, 1, 0, 0]);
  // M2 opens lane 2 for P; M1 joins it rather than opening lane 3.
  assert.equal(g.laneCount, 3);
  assert.ok(g.segments.some((s) => s.y1 === 2 && s.x1 === 1 && s.x2 === 2), 'M1 should join the open lane');
});
