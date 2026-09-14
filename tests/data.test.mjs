import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openRepoGraph } from '../src/data.js';

const OID = 'a'.repeat(40);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

test('meta fetch is retried after a transient failure', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('.git/')) return new Response('', { status: 401 }); // no freshen
    if (path.includes('/network/meta')) {
      // first attempt: flaky HTML error page; second: real payload
      if (calls.filter((c) => c.includes('/network/meta')).length === 1) {
        return new Response('<html>error</html>', { status: 500 });
      }
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'hi' }],
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    const { commits } = source.view();
    assert.equal(commits.length, 1);
    assert.equal(commits[0].oid, OID);
    assert.equal(source.fresh, false);
    assert.equal(calls.filter((c) => c.includes('/network/meta')).length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('private repo freshens via web pages by default, never git', async () => {
  const FRESH_OID = 'b'.repeat(40);
  const realFetch = globalThis.fetch;
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'false' } : null,
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('.git/')) throw new Error('git endpoint hit on a private repo');
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'old' }],
      });
    }
    if (path.includes('/refs?type=branch')) return jsonResponse({ refs: ['main'] });
    if (path.includes('/refs?type=tag')) return jsonResponse({ refs: ['v1'] });
    if (path.includes('/latest-commit/main')) return jsonResponse({ oid: FRESH_OID });
    if (path.includes('/latest-commit/v1')) return jsonResponse({ oid: OID });
    if (path.includes(`/commit/${FRESH_OID}`)) {
      return jsonResponse({
        payload: {
          commit: {
            oid: FRESH_OID,
            parents: [OID],
            authoredDate: '2026-01-02T00:00:00Z',
            shortMessageMarkdownLink: '<a href="/x">new</a>',
            authors: [{ login: 'y', displayName: 'Y', avatarUrl: 'https://a/y.png' }],
          },
        },
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    assert.equal(source.private, true);
    assert.equal(source.fresh, true);
    assert.deepEqual(source.heads, [{ name: 'main', oid: FRESH_OID }]);
    assert.deepEqual(source.tags, [{ name: 'v1', oid: OID }]);
    const { commits } = source.view();
    assert.deepEqual(commits.map((c) => c.oid), [FRESH_OID, OID]);
    assert.equal(commits[0].login, 'y');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
    delete globalThis.localStorage;
  }
});

test('private repo whose page endpoints fail keeps the snapshot, marked stale', async () => {
  const realFetch = globalThis.fetch;
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'false' } : null,
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('.git/')) throw new Error('git endpoint hit on a private repo');
    if (path.includes('/latest-commit/') || path.includes('/refs?') || path.includes('/branches')) {
      throw new Error('endpoint down: ' + path);
    }
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'hi' }],
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    assert.equal(source.private, true);
    assert.equal(source.fresh, false);
    assert.deepEqual(source.tags, []);
    assert.equal(source.view().commits.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('private repo far behind the snapshot: one budget on open, the rest only on "load older"', async () => {
  // main moved 150 commits past the snapshot — more than one load may fetch.
  const chainOid = (n) => String(n).padStart(40, 'f'); // n = 1 is the new tip
  const GAP = 150;
  const realFetch = globalThis.fetch;
  let commitCalls = 0;
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'false' } : null,
    querySelectorAll: () => [],
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'old' }],
      });
    }
    if (path.includes('/refs?type=branch')) return jsonResponse({ refs: ['main'] });
    if (path.includes('/refs?type=tag')) return jsonResponse({ refs: [] });
    if (path.includes('/latest-commit/main')) return jsonResponse({ oid: chainOid(1) });
    const match = /\/commit\/([0-9a-f]{40})$/.exec(path);
    if (match) {
      commitCalls++;
      const n = Number(match[1].replace(/^f+/, ''));
      return jsonResponse({
        payload: {
          commit: {
            oid: match[1],
            parents: [n === GAP ? OID : chainOid(n + 1)],
            authoredDate: new Date(Date.UTC(2026, 5, 1) - n * 60000).toISOString(),
            shortMessageMarkdown: `c${n}`,
            authors: [],
          },
        },
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const progress = [];
    const source = await openRepoGraph('o', 'r', (count) => progress.push(count));
    await source.ready;
    // Opening spends one budget and draws what it got, from the live head down.
    assert.equal(commitCalls, 100);
    assert.equal(progress.at(-1), 100);
    assert.equal(source.fresh, true);
    assert.deepEqual(source.heads, [{ name: 'main', oid: chainOid(1) }]);
    assert.deepEqual(source.truncated, ['main']);
    assert.equal(source.hasMore(), true);
    const shown = source.view().commits.map((c) => c.oid);
    assert.equal(shown.length, 100);
    assert.equal(shown[0], chainOid(1));

    // Nothing further is fetched until the user asks for it.
    source.view();
    assert.equal(commitCalls, 100);

    await source.loadOlder();
    assert.deepEqual(source.truncated, []);
    assert.equal(source.hasMore(), false);
    const all = source.view().commits.map((c) => c.oid);
    assert.equal(all.length, GAP + 1);
    assert.equal(all.at(-1), OID);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('private repo comes back from the snapshot, ready once missing commits are in', async () => {
  const FRESH_OID = 'b'.repeat(40);
  const realFetch = globalThis.fetch;
  let releaseCommit;
  const commitGate = new Promise((resolve) => (releaseCommit = resolve));
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'false' } : null,
    querySelectorAll: () => [],
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'old' }],
      });
    }
    if (path.includes('/refs?type=branch')) return jsonResponse({ refs: ['main'] });
    if (path.includes('/refs?type=tag')) return jsonResponse({ refs: [] });
    if (path.includes('/latest-commit/main')) return jsonResponse({ oid: FRESH_OID });
    if (path.includes('/commits/')) return new Response('', { status: 404 });
    if (path.includes(`/commit/${FRESH_OID}`)) {
      await commitGate;
      return jsonResponse({
        payload: { commit: { oid: FRESH_OID, parents: [OID], authoredDate: '2026-01-02T00:00:00Z', authors: [] } },
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    // handed back from the snapshot while the commit page is still out
    assert.equal(source.updating, true);
    assert.deepEqual(source.heads, [{ name: 'main', oid: OID }]);
    assert.equal(source.view().commits.length, 1);
    // a pick made meanwhile waits for the load instead of racing it
    const events = [];
    const picked = source.selectBranches(['main']).then(() => events.push(['picked', source.updating]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, []);
    releaseCommit();
    await source.ready;
    await picked;
    assert.deepEqual(events, [['picked', false]]);
    assert.equal(source.updating, false);
    assert.equal(source.fresh, true);
    assert.deepEqual(source.view().commits.map((c) => c.oid), [FRESH_OID, OID]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('202 (snapshot being generated) is polled through', async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // collapse the waits
  let metaCalls = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('.git/')) return new Response('', { status: 401 });
    if (path.includes('/network/meta')) {
      if (++metaCalls <= 2) return new Response('', { status: 202 });
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'hi' }],
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    assert.equal(source.view().commits.length, 1);
    assert.equal(metaCalls, 3);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('persistent 202 surfaces a "still generating" error, not "no data"', async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  let metaCalls = 0;
  globalThis.fetch = async (url) => {
    // The ref list and tags ride alongside; only the snapshot is polled.
    if (String(url).includes('/network/meta')) metaCalls++;
    return new Response('', { status: 202 });
  };
  try {
    await assert.rejects(() => openRepoGraph('o', 'r'), /still generating/);
    assert.equal(metaCalls, 6); // initial attempt + the five pending waits
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('chunk windows use the endpoint\'s inclusive end parameter', async () => {
  const chunkUrls = [];
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: new Array(150).fill('2026-01-01'),
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: OID }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      chunkUrls.push(new URL(path, 'https://github.com'));
      // second (older) window: persistently broken
      if (chunkUrls.length > 1) return new Response('<html>error</html>', { status: 500 });
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'X', login: 'x', date: '2026-01-01 00:00:00', message: 'hi' }],
      });
    }
    throw new Error('unexpected url: ' + path);
  };
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    // newest window of 100 over 150 commits: [50, 150) sent as start=50&end=149
    assert.equal(chunkUrls[0].searchParams.get('start'), '50');
    assert.equal(chunkUrls[0].searchParams.get('end'), '149');
    assert.equal(source.hasMore(), true);
    assert.equal(source.olderCount(), 50);

    await source.loadOlder();
    // older window [0, 50) sent as start=0&end=49; its failure is counted,
    // not silently swallowed, and pagination still terminates
    assert.equal(chunkUrls.at(-1).searchParams.get('start'), '0');
    assert.equal(chunkUrls.at(-1).searchParams.get('end'), '49');
    assert.equal(source.failedWindows(), 1);
    assert.equal(source.hasMore(), false);
    assert.equal(source.view().commits.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

// --- public freshen completeness ------------------------------------------
// Minimal pack fabrication (plain commit objects only, no deltas).

function oidOf(content) {
  return createHash('sha1')
    .update(`commit ${content.length}\0`)
    .update(content)
    .digest('hex');
}

function commitBytes({ parents = [], message }) {
  const author = 'A D <a@d> 1783425707 +0200';
  return Buffer.from(
    'tree 5d6ce700f8d74e8de7dfaf0d89a35f75b94d1483\n' +
      parents.map((p) => `parent ${p}\n`).join('') +
      `author ${author}\ncommitter ${author}\n\n${message}`
  );
}

function packOf(objects) {
  const header = Buffer.concat([
    Buffer.from('PACK'),
    Buffer.from([0, 0, 0, 2, 0, 0, 0, objects.length]),
  ]);
  const bodies = objects.map((content) => {
    assert.ok(content.length < 2048, 'test helper: two-byte size header only');
    return Buffer.concat([Buffer.from([(1 << 4) | (content.length & 15) | 0x80, content.length >> 4]), zlib.deflateSync(content)]);
  });
  return Buffer.concat([header, ...bodies, Buffer.alloc(20)]);
}

const pkt = (buf) => {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
};

function publicFreshenFetch({ snapshotOid, headOid, packObjects }) {
  return async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-01-01'],
        users: [{ name: 'o', repo: 'r', heads: [{ name: 'main', id: snapshotOid }] }],
      });
    }
    if (path.includes('/network/chunk')) {
      return jsonResponse({
        commits: [{ id: snapshotOid, parents: [], author: 'A D', login: 'ad', date: '2026-01-01 00:00:00', message: 'old' }],
      });
    }
    if (path.includes('.git/git-upload-pack')) {
      if (String(init.body).includes('command=ls-refs')) {
        return new Response(
          pkt(`${headOid} refs/heads/main\n`).toString() +
            pkt(`${snapshotOid} refs/tags/v1\n`).toString() +
            '0000',
        );
      }
      const body = Buffer.concat([
        pkt('packfile\n'),
        pkt(Buffer.concat([Buffer.from([1]), packOf(packObjects)])),
        Buffer.from('0000'),
      ]);
      return new Response(body);
    }
    throw new Error('unexpected url: ' + path);
  };
}

test('public freshen splices commits when the pack closes the gap', async () => {
  const b = commitBytes({ parents: [OID], message: 'mid\n' });
  const c = commitBytes({ parents: [oidOf(b)], message: 'tip\n' });
  const realFetch = globalThis.fetch;
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'true' } : null,
  };
  globalThis.fetch = publicFreshenFetch({ snapshotOid: OID, headOid: oidOf(c), packObjects: [b, c] });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    assert.equal(source.fresh, true);
    assert.deepEqual(source.heads, [{ name: 'main', oid: oidOf(c) }]);
    assert.deepEqual(source.tags, [{ name: 'v1', oid: OID }]);
    assert.deepEqual(source.view().commits.map((commit) => commit.oid), [oidOf(c), oidOf(b), OID]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('public freshen keeps the consistent snapshot when the pack leaves a gap', async () => {
  const b = commitBytes({ parents: [OID], message: 'mid\n' });
  const c = commitBytes({ parents: [oidOf(b)], message: 'tip\n' });
  const realFetch = globalThis.fetch;
  globalThis.document = {
    querySelector: (selector) =>
      selector.includes('repository_public') ? { content: 'true' } : null,
  };
  // The pack holds only the tip; its parent is neither in the pack nor known,
  // so splicing would draw history floating above a gap.
  globalThis.fetch = publicFreshenFetch({ snapshotOid: OID, headOid: oidOf(c), packObjects: [c] });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    assert.equal(source.fresh, false);
    assert.deepEqual(source.heads, [{ name: 'main', oid: OID }]);
    // exact tags survive even when splicing is refused: they are ref data,
    // not spliced history
    assert.deepEqual(source.tags, [{ name: 'v1', oid: OID }]);
    assert.deepEqual(source.view().commits.map((commit) => commit.oid), [OID]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('404 fails immediately without retries', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('', { status: 404 });
  };
  try {
    await assert.rejects(() => openRepoGraph('o', 'gone'), /No network-graph data/);
    assert.equal(calls.filter((c) => c.includes('/network/')).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- branch selection ------------------------------------------------------
// A branch whose tip is outside the loaded network window is no root, so
// nothing of it used to be drawn — the bug this feature exists for. The tip
// is materialised on demand, when the branch is selected.

const FEAT_TIP = 'c'.repeat(40);

function branchPickerFetch({ packObjects, featOid = FEAT_TIP, onFetchBody = () => {} }) {
  return async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/network/meta')) {
      return jsonResponse({
        nethash: 'h',
        dates: ['2026-07-01'],
        users: [{
          name: 'o',
          repo: 'r',
          heads: [{ name: 'main', id: OID }, { name: 'feature', id: featOid }],
        }],
      });
    }
    if (path.includes('/network/chunk')) {
      // The window holds main's tip only; feature's tip is older than the
      // newest 100 entries of the network array and never lands in it.
      return jsonResponse({
        commits: [{ id: OID, parents: [], author: 'A D', login: 'ad', date: '2026-07-01 00:00:00', message: 'base' }],
      });
    }
    if (path.includes('.git/git-upload-pack')) {
      if (String(init.body).includes('command=ls-refs')) {
        return new Response(
          pkt(`${OID} HEAD symref-target:refs/heads/main\n`).toString() +
            pkt(`${OID} refs/heads/main\n`).toString() +
            pkt(`${featOid} refs/heads/feature\n`).toString() +
            '0000',
        );
      }
      onFetchBody(String(init.body));
      return new Response(Buffer.concat([
        pkt('packfile\n'),
        pkt(Buffer.concat([Buffer.from([1]), packOf(packObjects)])),
        Buffer.from('0000'),
      ]));
    }
    throw new Error('unexpected url: ' + path);
  };
}

const publicDocument = {
  querySelector: (selector) =>
    selector.includes('repository_public') ? { content: 'true' } : null,
  querySelectorAll: () => [],
};

test('an unmerged branch outside the window is offered, drawn when selected', async () => {
  const mid = commitBytes({ parents: [OID], message: 'feature work\n' });
  const tip = commitBytes({ parents: [oidOf(mid)], message: 'feature tip\n' });
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.document = publicDocument;
  globalThis.fetch = branchPickerFetch({
    packObjects: [mid, tip],
    featOid: oidOf(tip),
    onFetchBody: (body) => bodies.push(body),
  });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;

    // Default: only what the window already holds, so no extra request.
    assert.equal(source.defaultBranch, 'main');
    assert.deepEqual([...source.selected], ['main']);
    assert.deepEqual(source.branches, [
      { name: 'main', oid: OID, loaded: true },
      { name: 'feature', oid: oidOf(tip), loaded: false },
    ]);
    assert.equal(bodies.length, 0);
    assert.deepEqual(source.view().commits.map((c) => c.oid), [OID]);

    await source.selectBranches(['main', 'feature']);
    assert.equal(bodies.length, 1);
    // "have" would promise the server ancestors we do not hold; the window is
    // a slice of the network array, not an ancestor-closed set.
    assert.ok(!bodies[0].includes('have '), 'the fetch must not negotiate haves');
    assert.ok(bodies[0].includes(`want ${oidOf(tip)}`));

    assert.deepEqual(source.heads, [
      { name: 'main', oid: OID },
      { name: 'feature', oid: oidOf(tip) },
    ]);
    assert.deepEqual(source.truncated, []);
    // Newest first, and the branch is spliced in above the base it forked from.
    assert.deepEqual(source.view().commits.map((c) => c.oid), [oidOf(tip), oidOf(mid), OID]);
    assert.equal(source.fresh, true);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('a branch that reaches deeper than the fetch is drawn as a stub, not dropped', async () => {
  // The pack carries the tip but not its parent: the branch forked further
  // back than the fetch bound. It still gets a row, a chip and a dashed tail.
  const tip = commitBytes({ parents: ['9'.repeat(40)], message: 'old branch tip\n' });
  const realFetch = globalThis.fetch;
  globalThis.document = publicDocument;
  globalThis.fetch = branchPickerFetch({ packObjects: [tip], featOid: oidOf(tip) });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    await source.selectBranches(['main', 'feature']);
    assert.deepEqual(source.truncated, ['feature']);
    assert.deepEqual(source.view().commits.map((c) => c.oid), [oidOf(tip), OID]);
    assert.deepEqual(source.heads.map((h) => h.name), ['main', 'feature']);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

test('deselecting a branch removes its commits from the graph', async () => {
  const side = commitBytes({ parents: [OID], message: 'side\n' });
  const realFetch = globalThis.fetch;
  globalThis.document = publicDocument;
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
  };
  globalThis.fetch = branchPickerFetch({ packObjects: [side], featOid: oidOf(side) });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    await source.selectBranches(['main', 'feature']);
    assert.equal(source.view().commits.length, 2);

    await source.selectBranches(['main']);
    assert.deepEqual(source.view().commits.map((c) => c.oid), [OID]);
    assert.deepEqual(source.heads, [{ name: 'main', oid: OID }]);
    // and the choice is remembered for the next visit
    assert.deepEqual(JSON.parse(store['ggt-branches'])['o/r'], ['main']);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
    delete globalThis.localStorage;
  }
});

test('the default branch stays drawn, in lane 0, when only another branch is picked', async () => {
  // `feature` is ahead of `main`; picking just `feature` must still draw
  // `main`, and `main` (not the newer tip) owns the leftmost lane.
  const side = commitBytes({ parents: [OID], message: 'side\n' });
  const realFetch = globalThis.fetch;
  globalThis.document = publicDocument;
  globalThis.fetch = branchPickerFetch({ packObjects: [side], featOid: oidOf(side) });
  try {
    const source = await openRepoGraph('o', 'r');
    await source.ready;
    await source.selectBranches(['feature']);
    assert.deepEqual(source.heads.map((h) => h.name).sort(), ['feature', 'main']);
    assert.equal(source.pinnedOid, OID);
    assert.ok(source.selected.has('main'));
    assert.deepEqual(source.view().commits.map((c) => c.oid), [oidOf(side), OID]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});
