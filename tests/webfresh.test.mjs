import test from 'node:test';
import assert from 'node:assert/strict';
import { webFreshen, webTags } from '../src/webfresh.js';

const sha = (letter) => letter.repeat(40);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

const commitJson = (commit) => jsonResponse({ payload: { commit } });

function withFetch(routes, run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, init });
    for (const [prefix, response] of Object.entries(routes)) {
      if (path.startsWith(prefix)) return response(path);
    }
    throw new Error('unexpected url: ' + path);
  };
  return run(calls).finally(() => {
    globalThis.fetch = realFetch;
  });
}

test('walks commit pages from the fresh head down to a known oid', () => {
  const byOid = new Map([[sha('a'), {}]]);
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      [`/o/r/commit/${sha('c')}`]: () =>
        commitJson({
          oid: sha('c'),
          parents: [sha('b')],
          authoredDate: '2026-07-07T10:00:00Z',
          shortMessageMarkdownLink: '<a href="/x">Fix &amp; polish</a>',
          bodyMessageHtml: 'details <b>here</b>',
          authors: [{ login: 'x', displayName: 'X', avatarUrl: 'https://a/x.png' }],
        }),
      [`/o/r/commit/${sha('b')}`]: () =>
        commitJson({
          oid: sha('b'),
          parents: [sha('a')],
          authoredDate: '2026-07-07T09:00:00Z',
          // live pages populate one markdown variant or the other
          shortMessageMarkdown: '<div>older</div>',
          authors: [],
        }),
    },
    async (calls) => {
      const { heads, commits, fresh } = await webFreshen(
        'o', 'r', [{ name: 'main', oid: sha('a') }], byOid,
      );
      assert.equal(fresh, true);
      assert.deepEqual(heads, [{ name: 'main', oid: sha('c') }]);
      assert.deepEqual(commits.map((c) => c.oid), [sha('c'), sha('b')]);
      const top = commits[0];
      assert.equal(top.subject, 'Fix & polish');
      assert.equal(top.message, 'Fix & polish\n\ndetails here');
      assert.equal(top.login, 'x');
      assert.equal(top.avatar, 'https://a/x.png');
      assert.equal(top.date.toISOString(), '2026-07-07T10:00:00.000Z');
      assert.equal(commits[1].subject, 'older');
      // the known sha('a') was never fetched, and everything asked for JSON
      assert.equal(calls.filter((c) => c.path.includes('/commit/')).length, 2);
      assert.ok(calls.every((c) => c.init.headers.Accept === 'application/json'));
    },
  );
});

test('falls back to parsing the HTML page when the route ignores Accept', () => {
  const commit = {
    oid: sha('b'),
    parents: [sha('a')],
    authoredDate: '2026-07-07T10:00:00Z',
    shortMessageMarkdown: '<div>new</div>',
    authors: [{ login: 'x' }],
  };
  const blob = (payload) =>
    `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload })}</script>`;
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('b') }),
      [`/o/r/commit/${sha('b')}`]: () =>
        new Response(`<html>${blob({ preloaded: true })}${blob({ commit })}</html>`, {
          headers: { 'content-type': 'text/html' },
        }),
    },
    async () => {
      const { commits, fresh } = await webFreshen(
        'o', 'r', [{ name: 'main', oid: sha('a') }], new Map([[sha('a'), {}]]),
      );
      assert.equal(fresh, true);
      assert.equal(commits.length, 1);
      assert.equal(commits[0].subject, 'new');
      assert.equal(commits[0].login, 'x');
    },
  );
});

test('unmoved head below the loaded window is not walked', () => {
  // sha('d') is not in byOid (older than the window) but the branch has not
  // moved, so there is nothing to fetch and nothing to revert.
  return withFetch(
    { '/o/r/latest-commit/dead': () => jsonResponse({ oid: sha('d') }) },
    async (calls) => {
      const { heads, commits, fresh } = await webFreshen(
        'o', 'r', [{ name: 'dead', oid: sha('d') }], new Map(),
      );
      assert.equal(fresh, true);
      assert.deepEqual(heads, [{ name: 'dead', oid: sha('d') }]);
      assert.equal(commits.length, 0);
      assert.equal(calls.length, 1);
    },
  );
});

test('a moved head walks down to another snapshot head below the window', () => {
  // main moved by one commit whose parent is the old main head — which sits
  // below the loaded window. Snapshot heads still terminate the walk.
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('b') }),
      [`/o/r/commit/${sha('b')}`]: () =>
        commitJson({ oid: sha('b'), parents: [sha('a')], authoredDate: '2026-07-07T10:00:00Z', authors: [] }),
    },
    async (calls) => {
      const { commits, fresh } = await webFreshen(
        'o', 'r', [{ name: 'main', oid: sha('a') }], new Map(),
      );
      assert.equal(fresh, true);
      assert.deepEqual(commits.map((c) => c.oid), [sha('b')]);
      assert.equal(calls.filter((c) => c.path.includes('/commit/')).length, 1);
    },
  );
});

test('cached commits are reused, fetched ones written back, progress reported', () => {
  const stored = {};
  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify({
        [sha('b')]: {
          oid: sha('b'), parents: [sha('a')], subject: 'cached', message: 'cached',
          author: 'X', login: 'x', avatar: '', date: 5000,
        },
      }),
    setItem: (key, value) => {
      stored[key] = value;
    },
  };
  const progress = [];
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      [`/o/r/commit/${sha('c')}`]: () =>
        commitJson({
          oid: sha('c'),
          parents: [sha('b')],
          authoredDate: '2026-07-07T10:00:00Z',
          shortMessageMarkdown: '<div>new</div>',
          authors: [],
        }),
    },
    async (calls) => {
      const { commits, fresh } = await webFreshen(
        'o', 'r', [{ name: 'main', oid: sha('a') }], new Map([[sha('a'), {}]]),
        (count) => progress.push(count),
      );
      assert.equal(fresh, true);
      assert.deepEqual(commits.map((c) => c.oid), [sha('c'), sha('b')]);
      assert.equal(commits[1].subject, 'cached');
      assert.equal(commits[1].date.getTime(), 5000);
      // only sha('c') hit the network, and it was reported and written back
      assert.equal(calls.filter((c) => c.path.includes('/commit/')).length, 1);
      assert.deepEqual(progress, [1]);
      const written = JSON.parse(stored['ggt-commits']);
      assert.ok(written[sha('b')] && written[sha('c')]);
      assert.equal(written[sha('c')].date, Date.parse('2026-07-07T10:00:00Z'));
    },
  ).finally(() => {
    delete globalThis.localStorage;
  });
});

test('refs are URL-encoded and deleted branches are dropped', () => {
  const byOid = new Map([[sha('a'), {}]]);
  return withFetch(
    {
      '/o/r/latest-commit/feat%2Fx': () => jsonResponse({ oid: sha('a') }),
      '/o/r/latest-commit/gone': () => new Response('', { status: 404 }),
    },
    async () => {
      const { heads, fresh } = await webFreshen(
        'o', 'r',
        [{ name: 'feat/x', oid: sha('a') }, { name: 'gone', oid: sha('b') }],
        byOid,
      );
      assert.equal(fresh, true);
      assert.deepEqual(heads, [{ name: 'feat/x', oid: sha('a') }]);
    },
  );
});

test('a branch that hits the page cap reverts alone; others still freshen', () => {
  const byOid = new Map([[sha('a'), {}]]);
  let counter = 0;
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      '/o/r/latest-commit/huge': () => jsonResponse({ oid: sha('f') }),
      [`/o/r/commit/${sha('c')}`]: () =>
        commitJson({ oid: sha('c'), parents: [sha('a')], authoredDate: '2026-07-07T10:00:00Z', authors: [] }),
      '/o/r/commit/': (path) =>
        // an endless parent chain that never reaches a known oid
        commitJson({
          oid: path.split('/').pop(),
          parents: [String(counter++).padStart(40, '0')],
          authoredDate: '2026-07-07T00:00:00Z',
          authors: [],
        }),
    },
    async (calls) => {
      const { heads, commits, fresh } = await webFreshen(
        'o', 'r',
        [{ name: 'main', oid: sha('a') }, { name: 'huge', oid: sha('e') }],
        byOid,
      );
      assert.equal(fresh, false);
      // main got its fresh head and commit; huge fell back to its snapshot oid
      assert.deepEqual(heads, [{ name: 'main', oid: sha('c') }, { name: 'huge', oid: sha('e') }]);
      // huge's partial chain is discarded, not spliced with a hole
      assert.deepEqual(commits.map((c) => c.oid), [sha('c')]);
      assert.ok(calls.filter((c) => c.path.includes('/commit/')).length <= 101);
    },
  );
});

test('webTags lists tags and resolves each to its peeled commit', () =>
  withFetch(
    {
      '/o/r/refs?type=tag': () => jsonResponse({ refs: ['v2.0.0', 'v1.0.0', 'gone'] }),
      '/o/r/latest-commit/v2.0.0': () => jsonResponse({ oid: sha('d') }),
      '/o/r/latest-commit/v1.0.0': () => jsonResponse({ oid: sha('a') }),
      // deleted between the list and the resolve: dropped, not fatal
      '/o/r/latest-commit/gone': () => new Response('', { status: 404 }),
    },
    async () => {
      const tags = await webTags('o', 'r');
      assert.deepEqual(tags, [
        { name: 'v2.0.0', oid: sha('d') },
        { name: 'v1.0.0', oid: sha('a') },
      ]);
    },
  ));

test('webTags surfaces a failed tag list as a throw', () =>
  withFetch(
    {
      '/o/r/refs?type=tag': () => new Response('', { status: 500 }),
    },
    () => assert.rejects(() => webTags('o', 'r'), /refs: HTTP 500/),
  ));

// GitHub moved the commit object from payload.commit to
// payload.commitRoute.commit. Both shapes must walk identically, otherwise
// every page fetch throws "commit: no payload", the walk is abandoned and the
// branch silently reverts to its stale snapshot head.
const commitRouteJson = (commit) => jsonResponse({ payload: { commitRoute: { commit } } });

test('reads the commit object from payload.commitRoute.commit', () => {
  const byOid = new Map([[sha('a'), {}]]);
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      [`/o/r/commit/${sha('c')}`]: () =>
        commitRouteJson({
          oid: sha('c'),
          parents: [sha('a')],
          authoredDate: '2026-08-19T10:00:00Z',
          shortMessageMarkdown: '<div>merge: land the thing</div>',
          authors: [{ login: 'x', displayName: 'X', avatarUrl: 'https://a/x.png' }],
        }),
    },
    async () => {
      const result = await webFreshen('o', 'r', [{ name: 'main', oid: sha('a') }], byOid);
      assert.equal(result.fresh, true);
      assert.deepEqual(result.heads, [{ name: 'main', oid: sha('c') }]);
      assert.equal(result.commits.length, 1);
      assert.equal(result.commits[0].oid, sha('c'));
      assert.deepEqual(result.commits[0].parents, [sha('a')]);
      assert.equal(result.commits[0].subject, 'merge: land the thing');
    },
  );
});

test('falls back to the embedded HTML payload when the JSON carries no commit', () => {
  const byOid = new Map([[sha('a'), {}]]);
  const commit = {
    oid: sha('c'),
    parents: [sha('a')],
    authoredDate: '2026-08-19T10:00:00Z',
    shortMessageMarkdown: '<div>from html</div>',
    authors: [{ login: 'x', displayName: 'X', avatarUrl: 'https://a/x.png' }],
  };
  // Same URL twice: the JSON attempt first, the HTML page after it came back
  // without a commit — so the fallback cannot key off the content-type.
  let jsonServed = false;
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      [`/o/r/commit/${sha('c')}`]: () => {
        if (!jsonServed) {
          jsonServed = true;
          return jsonResponse({ payload: { commitRoute: {} } });
        }
        return new Response(
          `<script data-target="react-app.embeddedData">${JSON.stringify({ payload: { commit } })}</script>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
    },
    async () => {
      const result = await webFreshen('o', 'r', [{ name: 'main', oid: sha('a') }], byOid);
      assert.equal(jsonServed, true, 'the JSON route must be tried first');
      assert.equal(result.fresh, true);
      assert.equal(result.commits[0].subject, 'from html');
    },
  );
});

test('a walk that hits the page cap reports no progress after it returns', () => {
  const byOid = new Map([[sha('a'), {}]]);
  let counter = 0;
  const fresh = () => String(counter++).padStart(40, '0');
  return withFetch(
    {
      '/o/r/latest-commit/main': () => jsonResponse({ oid: sha('c') }),
      // every commit a merge of two unseen parents: waves double until one
      // crosses the cap with some of its fetches already in flight
      '/o/r/commit/': (path) =>
        new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
          commitJson({
            oid: path.split('/').pop(),
            parents: [fresh(), fresh()],
            authoredDate: '2026-07-07T00:00:00Z',
            authors: [],
          })),
    },
    async () => {
      const progress = [];
      const { fresh: isFresh } = await webFreshen(
        'o', 'r', [{ name: 'main', oid: sha('a') }], byOid, (count) => progress.push(count),
      );
      assert.equal(isFresh, false);
      const seen = progress.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      // a late tick would repaint the loading screen over the drawn graph
      assert.equal(progress.length, seen);
    },
  );
});
