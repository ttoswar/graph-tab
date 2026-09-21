// Lane layout for a commit graph, following the classic `git log --graph`
// model (see also vscode-git-graph's Graph class): walk commits newest-first
// and keep a list of active lanes, each waiting for the sha it must reach
// next. Lanes are released when their commit is emitted and reused for later
// branches, merges join the existing lane of their target when one is open,
// and octopus merges (3+ parents) fall out of the same per-parent loop.
//
// Pure and DOM-free so it can be unit-tested in Node.

/**
 * @param {Array<{oid: string, parents: string[]}>} commits newest-first;
 *   children must appear before their parents (GitHub's network order,
 *   reversed, guarantees this). Parents outside the array are tolerated and
 *   produce dashed tail segments at the bottom of the graph.
 * @param {{pinnedOid?: string}} [options] when `pinnedOid` is a commit in the
 *   array, lane 0 is reserved for it and for everything its first parent
 *   walks into, and no other branch may ever take that lane. The default
 *   branch then always reads as the leftmost line, whatever order the rows
 *   happen to arrive in — otherwise lane 0 simply goes to whichever commit
 *   is newest, which on a busy repository is any random topic branch.
 * @returns {{
 *   nodes: Array<{row: number, x: number, color: number}>,   // per commit, same order
 *   segments: Array<{x1: number, y1: number, x2: number, y2: number, color: number, dashed?: boolean}>,
 *   laneCount: number
 * }} coordinates are in grid units: x in lanes, y in rows.
 */
export function layout(commits, options = {}) {
  const lanes = []; // per lane: null or { sha, color, bornAtX?, lastSeg?, reserved? }
  let joins = [];   // merge edges waiting for their next-row anchor: { fromX, sha }
  const nodes = [];
  const segments = [];
  let nextColor = 0;
  let laneCount = 0;

  // Reserve lane 0 for the pinned branch. `reserved` suppresses the lane's
  // edges until its commit is actually reached, so the rows above it do not
  // grow a line that comes from nowhere; from then on it is an ordinary lane
  // that happens to live at x = 0.
  const pinned = options.pinnedOid && commits.some((c) => c.oid === options.pinnedOid);
  const floor = pinned ? 1 : 0; // lowest lane index anything else may take
  if (pinned) {
    lanes[0] = { sha: options.pinnedOid, color: nextColor++, reserved: true };
    laneCount = 1;
  }

  const findLane = (sha) => lanes.findIndex((lane) => lane !== null && lane.sha === sha);
  // A lane that is actually drawing towards `sha`. The reserved lane is not
  // one: it draws nothing until its commit is reached, so a merge edge that
  // joined it would end in mid-air one row below the merge and the pinned
  // node would appear rows later with nothing coming into it. Such an edge
  // gets a lane of its own instead, which bends into lane 0 when the pinned
  // commit arrives — exactly as a first-parent edge to it already does.
  const findOpenLane = (sha) =>
    lanes.findIndex((lane) => lane !== null && lane.sha === sha && !lane.reserved);
  const freeLane = () => {
    // Lane 0 stays the pinned branch's for the whole graph, even after its
    // history ends, so the leftmost line never turns into something else.
    const k = lanes.indexOf(null, floor);
    return k === -1 ? Math.max(lanes.length, floor) : k;
  };

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];

    // Where this commit sits: the leftmost lane waiting for it, or a free
    // lane when it is a branch tip.
    let x = findLane(commit.oid);
    let color;
    if (x === -1) {
      x = freeLane();
      color = nextColor++;
    } else {
      color = lanes[x].color;
    }

    // Emit the edges from the previous row into this one. Lanes waiting for
    // this commit bend into its node; everything else continues straight
    // down. Consecutive straight segments of an untouched lane are coalesced.
    if (row > 0) {
      const y1 = row - 1;
      for (let k = 0; k < lanes.length; k++) {
        const lane = lanes[k];
        if (!lane || lane.reserved) continue;
        const x1 = lane.bornAtX !== undefined ? lane.bornAtX : k;
        const x2 = lane.sha === commit.oid ? x : k;
        delete lane.bornAtX;
        const straight = x1 === k && x2 === k;
        if (straight && lane.lastSeg && lane.lastSeg.y2 === y1) {
          lane.lastSeg.y2 = row;
        } else {
          const seg = { x1, y1, x2, y2: row, color: lane.color };
          segments.push(seg);
          lane.lastSeg = straight ? seg : null; // only vertical runs may extend
        }
      }
      for (const join of joins) {
        const target = findOpenLane(join.sha);
        const x2 = join.sha === commit.oid ? x : target;
        segments.push({ x1: join.fromX, y1, x2, y2: row, color: lanes[target].color });
      }
      joins = [];
    }

    nodes.push({ row, x, color });

    // Release every lane that was waiting for this commit.
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] !== null && lanes[k].sha === commit.oid) lanes[k] = null;
    }

    // The first parent continues this commit's branch in the same lane.
    const parents = commit.parents;
    if (parents.length > 0) {
      lanes[x] = { sha: parents[0], color };
    }

    // Remaining parents (merge sources): join the lane already waiting for
    // that sha when one is open, otherwise start a new lane from this node.
    for (let p = 1; p < parents.length; p++) {
      const sha = parents[p];
      if (findOpenLane(sha) !== -1) {
        joins.push({ fromX: x, sha });
      } else {
        const k = freeLane();
        lanes[k] = { sha, color: nextColor++, bornAtX: x };
      }
    }

    laneCount = Math.max(laneCount, x + 1, lanes.length);
    while (lanes.length > floor && lanes[lanes.length - 1] === null) lanes.pop();
  }

  // Parents that never arrived (outside the fetched window): dashed tails so
  // the graph honestly shows the history continues below.
  const y1 = commits.length - 1;
  const y2 = commits.length - 0.5;
  for (let k = 0; k < lanes.length; k++) {
    const lane = lanes[k];
    if (!lane || lane.reserved) continue;
    const x1 = lane.bornAtX !== undefined ? lane.bornAtX : k;
    segments.push({ x1, y1, x2: k, y2, color: lane.color, dashed: true });
  }
  for (const join of joins) {
    const target = findLane(join.sha);
    segments.push({ x1: join.fromX, y1, x2: target, y2, color: lanes[target].color, dashed: true });
  }

  return { nodes, segments, laneCount };
}
