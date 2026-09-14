// No-auth data source: GitHub's internal network-graph endpoints.
//
//   GET /{owner}/{repo}/network/meta
//   GET /{owner}/{repo}/network/chunk?nethash={meta.nethash}&start={n}&end={m}
//
// Same-origin fetches from a content script ride the user's session cookie,
// so anything the user can view in the browser (public, private, org repos)
// works with zero setup. The endpoints are undocumented, so parsing is
// defensive and every failure surfaces as a thrown Error the UI can show.
//
// Empirical facts these functions rely on (verified 2026-07, see
// le-git-graph/NETWORK_GRAPH_RENDERER.md):
//   - the chunk array is oldest-first; meta.dates.length is the total count,
//     so the newest window is [total - N, total);
//   - the chunk end parameter is INCLUSIVE (start=0&end=2 returns 3 commits;
//     an end past the array is clamped), so half-open windows send end - 1;
//   - meta/chunk cover the whole fork network with interleaved commits, and
//     the only correct way to isolate the focused repo is reachability from
//     meta.users[0].heads (author/owner/block filtering is wrong);
//   - that window is the newest N entries of the *network* array, so a branch
//     tip can be missing from it while the branch is very much alive. Such a
//     tip is no root, so nothing of the branch is drawn — which is why the
//     selected branches are materialised explicitly (see materialise below);
//   - parents come as [sha, time, space] tuples.

import { lsRefs, fetchMissingCommits } from './gitproto.js';
import { webFreshen, webExtend, webTags, webBranches } from './webfresh.js';
import { chronoIndex, orderCommits } from './order.js';
import { loadSelection, saveSelection, resolveSelection } from './branches.js';

const WINDOW = 100;

// Pulling a branch whose tip is outside the snapshot window means asking git
// for history it never negotiated away. `deepen` counts depth along every
// parent of a merge, so it is kept small and the result is cut down per
// branch afterwards: enough commits to show where the branch is and how it
// has been developing, not its whole history.
const BRANCH_DEPTH = 8;
const STUB_MAX = 12;

// The page itself says which it is; content scripts can read it directly.
// Unknown visibility counts as private: the public path must never probe a
// private repo's git endpoints, where the anonymous 401 could surface the
// browser's Basic-auth dialog. Every public repo page carries the tag.
function isPrivateRepo() {
  return (
    typeof document === 'undefined' ||
    document.querySelector('meta[name="octolytics-dimension-repository_public"]')?.content !== 'true'
  );
}

// The endpoints answer flaky sometimes (rate limits, stray HTML error pages);
// a couple of retries with backoff make loads reliable. 404 stays immediate:
// that is a real "no such repo/graph", not a hiccup.
const RETRY_DELAYS_MS = [500, 1500];

// 202 with an empty body means GitHub is generating the graph snapshot
// server-side (a repo's first visit; big fork networks take minutes) —
// GitHub's own network page polls through it exactly like this.
const PENDING_DELAYS_MS = [2000, 3000, 5000, 8000, 12000];
const PENDING_MESSAGE =
  'GitHub is still generating the graph data for this repository ' +
  '(large histories take a few minutes) — try again shortly.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, pendingDelays = []) {
  let pendingWaits = 0;
  let rateLimited = false;
  for (let attempt = 0; ; ) {
    let response = null;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        cache: 'no-store',
      });
    } catch {
      // network error; retry below
    }
    if (response) {
      if (response.status === 404) return null;
      if (response.status === 202) {
        if (pendingWaits >= pendingDelays.length) throw new Error(PENDING_MESSAGE);
        await sleep(pendingDelays[pendingWaits++]);
        continue;
      }
      rateLimited = response.status === 429;
      if (response.ok && (response.headers.get('content-type') || '').includes('json')) {
        try {
          return await response.json();
        } catch {
          // truncated JSON; retry below
        }
      }
    }
    if (attempt >= RETRY_DELAYS_MS.length) {
      if (rateLimited) {
        throw new Error('GitHub is rate-limiting graph requests — try again in a minute.');
      }
      return null;
    }
    await sleep(RETRY_DELAYS_MS[attempt++]);
  }
}

// "2025-10-31 21:09:46" (chunk format), ISO strings, or epoch numbers.
// Unparseable dates come back as null — the UI shows "—" rather than
// pretending the commit was authored "now".
function parseDate(value) {
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const date = new Date(String(value || '').replace(' ', 'T'));
  return isNaN(date.getTime()) ? null : date;
}

// idx is the commit's absolute position in GitHub's oldest-first network
// array; sorting by it descending reproduces GitHub's own newest-first,
// parents-after-children order that the layout requires.
function mapCommit(raw, idx) {
  if (!raw || typeof raw.id !== 'string') return null;
  const parents = [];
  for (const parent of raw.parents || []) {
    const sha = Array.isArray(parent) ? parent[0] : parent;
    if (typeof sha === 'string') parents.push(sha);
  }
  const message = String(raw.message || '');
  return {
    oid: raw.id,
    parents,
    subject: message.split('\n', 1)[0],
    message,
    author: raw.author || raw.login || '',
    login: raw.login || '',
    avatar:
      typeof raw.gravatar === 'string' && raw.gravatar.startsWith('http')
        ? raw.gravatar
        : raw.login
          ? `https://github.com/${encodeURIComponent(raw.login)}.png?size=40`
          : '',
    date: parseDate(raw.date),
    idx,
  };
}

// meta.users lists every fork in the network as { name, repo, heads }; the
// entry matching the URL (falling back to users[0], the focus) is this repo.
function focusedHeads(meta, owner, repo) {
  if (!Array.isArray(meta.users)) return [];
  const user =
    meta.users.find((u) => u && u.name === owner && u.repo === repo) || meta.users[0];
  if (!user || !Array.isArray(user.heads)) return [];
  const heads = [];
  for (const head of user.heads) {
    const oid = head && (head.id || head.sha || head.oid);
    if (head && head.name && typeof oid === 'string') heads.push({ name: head.name, oid });
  }
  return heads;
}

// Keep only commits reachable from the given heads by walking parent links
// within the loaded set. This is what excludes fork-network commits.
function reachableFrom(byOid, headOids) {
  const reachable = new Set();
  const stack = headOids.filter((oid) => byOid.has(oid));
  while (stack.length > 0) {
    const oid = stack.pop();
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    const commit = byOid.get(oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (byOid.has(parent) && !reachable.has(parent)) stack.push(parent);
    }
  }
  return reachable;
}

// Collect the commits from `tip` downwards through `fetched`, stopping where
// history is already known. Breadth-first, so the result starts at the tip
// and any prefix of it is still a connected piece of the branch.
//
// `closes` is false when a path dead-ends at an oid the pack did not carry:
// the branch then reaches further down than what was fetched, and only a stub
// of it can be drawn — which layout() finishes with a dashed tail rather than
// pretending the history ends there.
function collectFrom(tip, fetched, known) {
  const chain = [];
  const seen = new Set();
  let wave = [tip];
  let closes = true;
  while (wave.length > 0) {
    const next = [];
    for (const oid of wave) {
      if (seen.has(oid) || known.has(oid)) continue;
      const commit = fetched.get(oid);
      if (!commit) {
        closes = false;
        continue;
      }
      seen.add(oid);
      chain.push(commit);
      next.push(...commit.parents);
    }
    wave = next;
  }
  return { chain, closes };
}

// The repository page embeds its own metadata for GitHub's React views; the
// default branch is in there, which is the one branch the graph draws even
// when the user has picked nothing. Free (no request).
function pageDefaultBranch() {
  try {
    for (const script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      const match = /"defaultBranch":"((?:[^"\\]|\\.)*)"/.exec(script.textContent || '');
      if (match) return JSON.parse(`"${match[1]}"`);
    }
  } catch {
    // no DOM, or a shape GitHub has since changed
  }
  return '';
}

/**
 * Bring the selected branches into `byOid` over git smart-HTTP (public repos).
 *
 * Every selected head that is not already in the loaded window is asked for in
 * one request, which covers both jobs at once: heads that moved past the
 * network-graph snapshot need their new commits spliced in (the freshness
 * job), and heads that simply live outside the window need enough of their
 * history to be drawn at all.
 *
 * Mutates `branch.oid` when a moved branch has to fall back to its snapshot
 * head. Returns { fresh, truncated }.
 */
async function materialiseGit(owner, repo, dates, branches, byOid) {
  const wants = [...new Set(branches.filter((b) => !byOid.has(b.oid)).map((b) => b.oid))];
  if (wants.length === 0) return { fresh: true, truncated: [] };

  const missing = await fetchMissingCommits(owner, repo, wants, BRANCH_DEPTH);
  const fetched = new Map(missing.map((commit) => [commit.oid, commit]));

  // git objects carry name+email, not GitHub identities; recover login and
  // avatar from snapshot commits by the same author, else avatar by email.
  const identities = new Map();
  for (const commit of byOid.values()) {
    if (commit.login && commit.author) {
      identities.set(commit.author, { login: commit.login, avatar: commit.avatar });
    }
  }

  const truncated = [];
  let fresh = true;
  for (const branch of branches) {
    if (byOid.has(branch.oid)) continue;
    const { chain, closes } = collectFrom(branch.oid, fetched, byOid);
    // The head is known to be missing from the window here, so a snapshot
    // oid that *is* loaded is necessarily a different, older commit.
    const bridgeable = byOid.has(branch.snapOid);
    if (chain.length === 0 || (!closes && bridgeable)) {
      // Either nothing came back, or the branch moved and the gap could not be
      // bridged. A consistent, slightly stale head beats commits floating
      // above a hole, so fall back to the snapshot and say so.
      if (bridgeable) branch.oid = branch.snapOid;
      fresh = false;
      continue;
    }
    if (!closes) truncated.push(branch.name);
    for (const commit of closes ? chain : chain.slice(0, STUB_MAX)) {
      if (byOid.has(commit.oid)) continue;
      const known = identities.get(commit.author);
      byOid.set(commit.oid, {
        ...commit,
        subject: commit.message.split('\n', 1)[0],
        login: known ? known.login : '',
        avatar: known
          ? known.avatar
          : `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(commit.email)}&s=40`,
        idx: chronoIndex(dates, commit.date),
      });
    }
  }
  return { fresh, truncated };
}

// Same job over GitHub's page endpoints, for a private repo:
// git smart-HTTP ignores the web session there (see webfresh.js). Fetched
// commits are recorded in `webOids`: where they stop short of the loaded
// history is where "Load older commits" carries on. Returns { fresh }.
async function materialiseWeb(owner, repo, dates, branches, byOid, webOids, onProgress) {
  const result = await webFreshen(
    owner,
    repo,
    branches.map((branch) => ({
      name: branch.name,
      oid: branch.snapOid,
      materialize: !branch.snapOid || !byOid.has(branch.snapOid),
    })),
    byOid,
    onProgress,
  );
  spliceWeb(dates, result.commits, byOid, webOids);
  const live = new Map(result.heads.map((head) => [head.name, head.oid]));
  for (const branch of branches) branch.oid = live.get(branch.name);
  return { fresh: result.fresh };
}

function spliceWeb(dates, commits, byOid, webOids) {
  for (const commit of commits) {
    if (!byOid.has(commit.oid)) {
      byOid.set(commit.oid, { ...commit, idx: chronoIndex(dates, commit.date) });
      webOids.add(commit.oid);
    }
  }
}

// Parents of web-fetched commits under `headOids` that nothing has loaded:
// the points where a branch was cut short by the request budget. Snapshot
// heads count as known — the chunk windows bring those in.
function openParents(byOid, webOids, headOids, known) {
  const open = new Set();
  for (const oid of reachableFrom(byOid, headOids)) {
    if (!webOids.has(oid)) continue;
    for (const parent of byOid.get(oid).parents) {
      if (!byOid.has(parent) && !known.has(parent)) open.add(parent);
    }
  }
  return [...open];
}

/**
 * Open the graph data source for a repository.
 * @param onProgress called with a running fetch count while missing commits
 *   are pulled one request at a time (the private-repo path).
 * @returns {Promise<{
 *   owner, repo,
 *   heads,    // [{ name, oid }] the selected branches, for chips and roots
 *   branches, // [{ name, oid, loaded }] every branch, for the header picker
 *   selected, // Set of selected branch names
 *   defaultBranch,
 *   tags,     // [{ name, oid }] with annotated tags peeled to their commit;
 *             // empty when refs could not be read (offline, endpoint changed)
 *   fresh,    // false when no top-up was available (offline, endpoint changed)
 *   truncated,// branches drawn as a stub because their history never met the window
 *   canFetch, // false when no live ref source is available to pull a branch in
 *   private,  // true when freshness goes through the web pages (git endpoints reject the session)
 *   selectBranches(names): Promise<void>,
 *   view(): { commits, filtered },  // newest-first, reachability-filtered
 *   hasMore(): boolean,
 *   loadOlder(): Promise<void>
 * }>}
 */
export async function openRepoGraph(owner, repo, onProgress = () => {}) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // The ref list and the tags depend on nothing but the repository, so they
  // ride alongside the snapshot load rather than behind it — otherwise every
  // repo page pays a whole extra round trip before the graph can be drawn.
  // Rejections are caught here so an early failure cannot go unhandled while
  // the snapshot is still loading; the callers below read the result.
  const priv = isPrivateRepo();
  const refsPending = priv
    ? webBranches(owner, repo).catch(() => null)
    : lsRefs(owner, repo).catch(() => null);
  // Tags are decoration: losing them must not revert a good freshen.
  const tagsPending = priv && webTags(owner, repo).catch(() => []);

  const meta = await fetchJson(`${base}/network/meta`, PENDING_DELAYS_MS);
  if (!meta || typeof meta.nethash !== 'string') {
    throw new Error('No network-graph data for this repository (empty repo, or GitHub changed the endpoint).');
  }

  const dates = Array.isArray(meta.dates) ? meta.dates : [];
  const total = dates.length;
  const snapshot = focusedHeads(meta, owner, repo);
  const byOid = new Map();
  const webOids = new Set();
  let failedWindows = 0;

  // Windows are half-open [start, end), but the endpoint's end is inclusive.
  async function fetchWindow(start, end) {
    const params = new URLSearchParams({ nethash: meta.nethash, start: String(start), end: String(end - 1) });
    const chunk = await fetchJson(`${base}/network/chunk?${params}`);
    if (!chunk || !Array.isArray(chunk.commits)) return false;
    chunk.commits.forEach((raw, i) => {
      const commit = mapCommit(raw, start + i);
      if (commit && !byOid.has(commit.oid)) byOid.set(commit.oid, commit);
    });
    return true;
  }

  const end = total > 0 ? total : WINDOW;
  let loadedStart = Math.max(0, end - WINDOW);
  const ok = await fetchWindow(loadedStart, end);
  if (!ok || byOid.size === 0) {
    throw new Error('Could not load commits from the network graph.');
  }

  // --- refs ---------------------------------------------------------------
  // The snapshot's head list is the fallback; the live ref list is better
  // (it has branches the snapshot has not caught up with) and is the only
  // way to learn the default branch on a public repo.
  const snapByName = new Map(snapshot.map((head) => [head.name, head.oid]));
  const toBranches = (names, oidOf) =>
    names.map((name) => ({ name, oid: oidOf(name), snapOid: snapByName.get(name) }));
  let branches = snapshot.map((head) => ({ name: head.name, oid: head.oid, snapOid: head.oid }));
  let defaultBranch = pageDefaultBranch();
  let tags = [];
  let live = false;

  if (!priv) {
    const refs = await refsPending;
    if (refs) {
      if (refs.heads.length > 0) {
        const liveOids = new Map(refs.heads.map((head) => [head.name, head.oid]));
        branches = toBranches([...liveOids.keys()], (name) => liveOids.get(name));
        tags = refs.tags;
        if (refs.head) defaultBranch = refs.head;
        live = true;
      }
    }
    // A null result means anonymous git refused (GHES, offline); the
    // snapshot head list still works.
  } else {
    // webFreshen resolves every head live on its own, so the data is fresh
    // regardless; the branch list is only there to offer branches the
    // snapshot never saw.
    live = true;
    const listed = await refsPending;
    // A null result means the endpoint changed or is forbidden; the snapshot
    // head list still works.
    if (listed && listed.names.length > 0) {
      branches = toBranches(listed.names, (name) => snapByName.get(name));
      if (!defaultBranch) defaultBranch = listed.head;
    }
  }

  const isLoaded = (oid) => !!oid && byOid.has(oid);
  let selected = resolveSelection(loadSelection(owner, repo), branches, defaultBranch, isLoaded);
  async function materialise() {
    if (!live) return { fresh: false, truncated: [] };
    const chosen = branches.filter((branch) => selected.has(branch.name));
    try {
      return priv
        ? await materialiseWeb(owner, repo, dates, chosen, byOid, webOids, onProgress)
        : await materialiseGit(owner, repo, dates, chosen, byOid);
    } catch {
      return { fresh: false, truncated: [] };
    }
  }

  const selectedBranches = () => branches.filter((b) => selected.has(b.name) && b.oid);
  const snapOids = () => new Set(branches.map((b) => b.snapOid).filter(Boolean));
  const openTips = () =>
    priv ? openParents(byOid, webOids, selectedBranches().map((b) => b.oid), snapOids()) : [];

  // On a private repo, a branch is truncated when its web-fetched history is
  // still open at the bottom — read off the graph itself, so it stays right
  // after re-selection and after "Load older commits" closes a gap.
  const first = await materialise();
  let fresh = first.fresh;
  let gitTruncated = first.truncated || [];
  const truncatedNow = () => {
    if (!priv) return gitTruncated.filter((name) => selected.has(name));
    const known = snapOids();
    return selectedBranches()
      .filter((b) => openParents(byOid, webOids, [b.oid], known).length > 0)
      .map((b) => b.name);
  };

  if (tagsPending) tags = await tagsPending;

  return {
    owner,
    repo,
    defaultBranch,
    private: priv,
    // Whether a branch outside the loaded window can still be pulled in
    // (false only when no live ref source answered).
    canFetch: live,
    total,

    get heads() {
      return selectedBranches().map((branch) => ({ name: branch.name, oid: branch.oid }));
    },
    // Lane 0 is always the default branch's: it is drawn whatever else is
    // picked, so even a branch far ahead of it lands to its right.
    get pinnedOid() {
      return selectedBranches().find((branch) => branch.name === defaultBranch)?.oid || '';
    },
    get branches() {
      return branches.map((branch) => ({
        name: branch.name,
        oid: branch.oid || '',
        loaded: !!branch.oid && byOid.has(branch.oid),
      }));
    },
    get selected() {
      return new Set(selected);
    },
    get tags() {
      return tags;
    },
    get fresh() {
      return fresh;
    },
    get truncated() {
      return truncatedNow();
    },

    // Drawing a different set of branches only ever *adds* commits, so the
    // choice is applied in place: no refetch of meta or of the window — and
    // a pure deselection needs no fetch at all, the commits are just hidden.
    async selectBranches(names) {
      const before = selected;
      // Same normalisation as on open: the default branch is always in.
      selected = resolveSelection(names, branches, defaultBranch, isLoaded);
      saveSelection(owner, repo, [...selected]);
      if ([...selected].every((name) => before.has(name))) return;
      const result = await materialise();
      fresh = result.fresh;
      if (!priv) gitTruncated = result.truncated;
    },

    // filtered === false means no selected head landed in the loaded window,
    // so the raw fork network is shown rather than nothing.
    view() {
      const reachable = reachableFrom(byOid, selectedBranches().map((branch) => branch.oid));
      const all = [...byOid.values()];
      const filtered = reachable.size > 0;
      const commits = filtered ? all.filter((commit) => reachable.has(commit.oid)) : all;
      return { commits: orderCommits(commits), filtered };
    },

    loaded: () => byOid.size,
    hasMore: () => loadedStart > 0 || openTips().length > 0,
    olderCount: () => (loadedStart > 0 ? Math.min(WINDOW, loadedStart) : WINDOW),
    failedWindows: () => failedWindows,

    // The only way more history is fetched after a load: the next snapshot
    // window, then another budget of commits below branches that were cut
    // short (the window may already have closed some of those gaps).
    async loadOlder() {
      if (loadedStart > 0) {
        const olderEnd = loadedStart;
        const olderStart = Math.max(0, olderEnd - WINDOW);
        loadedStart = olderStart; // advance even on failure so a bad window can't loop
        let ok = false;
        try {
          ok = await fetchWindow(olderStart, olderEnd);
        } catch {
          // counted below; the view keeps its consistent loaded set
        }
        if (!ok) failedWindows++; // surfaced as a banner, not silently skipped
      }
      const tips = openTips();
      if (tips.length === 0) return;
      try {
        spliceWeb(dates, await webExtend(owner, repo, tips, byOid, snapOids()), byOid, webOids);
      } catch {
        // the branches stay open; the next click tries again
      }
    },
  };
}
