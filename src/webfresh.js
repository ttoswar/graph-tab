// Fresh commit data for private repos. Git smart-HTTP ignores the web
// session (gitproto.js gets an anonymous 401 there), but GitHub's own page
// endpoints ride the session cookie and are fresh immediately after a push:
//
//   GET /{owner}/{repo}/latest-commit/{ref}   (Accept: json)
//     -> { oid, ... } — the exact branch head
//   GET /{owner}/{repo}/commit/{oid}          (Accept: json, ~3 KB)
//     -> payload.commit — or payload.commitRoute.commit, which is where
//        GitHub moved the same object; both shapes are accepted — with
//        oid, parents (full shas), authoredDate,
//        shortMessage(Markdown(Link)), bodyMessageHtml,
//        authors [{ login, displayName, avatarUrl }]
//     (the same route serves ~230 KB HTML with the payload embedded as
//      react-app.embeddedData JSON — kept as a parsing fallback)
//
// Parents only come from the commit route, so this still costs one request
// per missing commit — hence MAX_PAGES, a hard budget per load. Only branches
// whose head moved are walked: a branch that moved further than the budget
// reaches is drawn from its live head down to the last commit fetched, and a
// branch whose walk fails outright (endpoint change) keeps its
// stale-but-consistent snapshot head while the others still freshen.

const MAX_PAGES = 100;

// A branch the snapshot window does not contain has to be walked from its tip
// downwards, and nothing guarantees it ever meets the loaded history — so a
// single such branch gets a small budget and is drawn as a stub with a dashed
// tail rather than being allowed to spend the whole page allowance.
const MAX_STUB_PAGES = 12;

// Tags cost one /latest-commit request each (names come bare from /refs),
// so the list is capped to the newest entries the endpoint returns first.
const MAX_TAGS = 30;

// Ref resolves go to session-cookie web endpoints, where a burst of dozens of
// parallel requests trips GitHub's abuse limiter (429s). Keep a few in flight.
const REF_CONCURRENCY = 5;

// Map `fn` over `items` with at most REF_CONCURRENCY calls in flight,
// preserving order.
async function mapLimited(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REF_CONCURRENCY, items.length) }, worker));
  return results;
}

const JSON_HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

// Commits are immutable, so an oid-keyed localStorage cache never goes
// stale. It makes reopening the graph cheap and lets a branch that hit the
// page cap get MAX_PAGES further on the next try. Insertion order doubles
// as the eviction order.
const CACHE_KEY = 'ggt-commits';
const CACHE_MAX = 500;

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const keys = Object.keys(cache);
  for (const key of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete cache[key];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable or full; just refetch next time
  }
}

function textOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name])
    .trim();
}

// Exact head oid for a branch, or null when the branch no longer exists
// (the snapshot's head list can lag deletions too).
async function latestOid(base, ref) {
  const response = await fetch(`${base}/latest-commit/${encodeURIComponent(ref)}`, {
    headers: JSON_HEADERS,
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`latest-commit: HTTP ${response.status}`);
  const { oid } = await response.json();
  if (!/^[0-9a-f]{40}$/.test(oid || '')) throw new Error('latest-commit: no oid');
  return oid;
}

/**
 * Every branch of a private repo over the same session-cookie web endpoint:
 * { names, head }. `/refs?type=branch` answers with bare names and lists the
 * repository's default branch first (checked against the `defaultBranch` the
 * repo page embeds), which is the one branch the graph always draws.
 */
export async function webBranches(owner, repo) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetch(`${base}/refs?type=branch`, {
    headers: JSON_HEADERS,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`refs: HTTP ${response.status}`);
  const { refs } = await response.json();
  const names = Array.isArray(refs) ? refs.filter((name) => typeof name === 'string' && name) : [];
  return { names, head: names[0] || '' };
}

/**
 * Tags for a private repo over the same session-cookie web endpoints:
 * [{ name, oid }]. `/refs?type=tag` returns bare names (newest first);
 * `/latest-commit/{tag}` resolves each one and peels annotated tags to the
 * commit they point at (verified against `git ls-remote 'v*^{}'`). Tags can
 * be re-pointed, so nothing here is cached. A tag that fails to resolve is
 * dropped rather than failing the batch.
 */
export async function webTags(owner, repo) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetch(`${base}/refs?type=tag`, {
    headers: JSON_HEADERS,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`refs: HTTP ${response.status}`);
  const { refs } = await response.json();
  if (!Array.isArray(refs)) return [];
  const names = refs.filter((name) => typeof name === 'string' && name).slice(0, MAX_TAGS);
  const tags = await mapLimited(names, (name) =>
    latestOid(base, name)
      .then((oid) => (oid ? { name, oid } : null))
      .catch(() => null),
  );
  return tags.filter(Boolean);
}

// The commit object lives at payload.commit on the older shape and at
// payload.commitRoute.commit on the current one; the object itself is
// identical, so both are read and the first match wins.
function commitOf(payload) {
  return payload?.commit ?? payload?.commitRoute?.commit ?? null;
}

// The commit payload out of an HTML commit page: several react-app.embeddedData
// blobs are embedded, only one carries the commit. GitHub escapes
// every "<" as \u003c inside them, so slicing to the next </script> is safe.
function embeddedCommit(html, oid) {
  const marker = /data-target="react-app\.embeddedData">/g;
  while (marker.exec(html)) {
    try {
      const { payload } = JSON.parse(html.slice(marker.lastIndex, html.indexOf('</script>', marker.lastIndex)));
      const commit = commitOf(payload);
      if (commit?.oid === oid) return commit;
    } catch {
      // not the blob we want
    }
  }
  return null;
}

async function fetchCommit(base, oid) {
  const response = await fetch(`${base}/commit/${oid}`, {
    headers: JSON_HEADERS,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`commit: HTTP ${response.status}`);
  // The JSON route can answer 200 with a shape that carries no commit at all;
  // the HTML page still embeds one, so fall back on content rather than on the
  // content-type alone — keying the fallback off the header would skip it
  // exactly when the JSON turned out to be useless.
  let commit = null;
  if ((response.headers.get('content-type') || '').includes('json')) {
    commit = commitOf((await response.json()).payload);
    if (!commit) {
      const html = await fetch(`${base}/commit/${oid}`, {
        credentials: 'include',
        cache: 'no-store',
      }).then((r) => (r.ok ? r.text() : ''));
      commit = embeddedCommit(html, oid);
    }
  } else {
    commit = embeddedCommit(await response.text(), oid);
  }
  if (!commit || commit.oid !== oid || !Array.isArray(commit.parents)) {
    throw new Error('commit: no payload');
  }
  // shortMessage is often null on the commit route; the markdown variants
  // carry the text (which one is populated varies).
  const subject =
    textOf(commit.shortMessageMarkdownLink || commit.shortMessageMarkdown) ||
    String(commit.shortMessage || '') ||
    oid.slice(0, 7);
  const body = textOf(commit.bodyMessageHtml);
  const author = (Array.isArray(commit.authors) && commit.authors[0]) || {};
  return {
    oid,
    parents: commit.parents.filter((sha) => typeof sha === 'string'),
    subject,
    message: body ? `${subject}\n\n${body}` : subject,
    author: author.displayName || author.login || '',
    login: author.login || '',
    avatar: author.avatarUrl || '',
    date: new Date(commit.authoredDate || commit.committedDate || Date.now()),
  };
}

// Commit pages over one request budget. `page` resolves a commit from the
// cache (free) or the network, and returns null without fetching once
// MAX_PAGES network requests have been spent: running out stops a walk where
// it is rather than failing it, so whatever was collected can still be drawn.
// Memoised, so parallel walks meeting at a merge fetch a page once.
function pager(base, onProgress) {
  const cache = loadCache();
  const pages = new Map();
  let fetched = 0;
  let done = 0;
  const page = (oid) => {
    if (pages.has(oid)) return pages.get(oid);
    let promise;
    if (cache[oid]) {
      promise = Promise.resolve({ ...cache[oid], date: new Date(cache[oid].date) });
    } else {
      if (fetched >= MAX_PAGES) return null;
      fetched++;
      promise = fetchCommit(base, oid).then((commit) => {
        cache[oid] = { ...commit, date: commit.date.getTime() };
        onProgress(++done);
        return commit;
      });
      // marks the rejection handled for walks that die before awaiting it
      promise.catch(() => {});
    }
    pages.set(oid, promise);
    return promise;
  };
  // A walk that fails mid-wave leaves that wave's other fetches in flight.
  // Let them land before the caller draws: otherwise their progress ticks
  // arrive after the graph is up and repaint the loading screen over it, and
  // their commits miss the cache write.
  const settle = async () => {
    await Promise.allSettled(pages.values());
    if (fetched > 0) saveCache(cache); // partial walks too: the next load resumes deeper
  };
  return { page, settle };
}

// Breadth-first from `starts`, each wave of parents in parallel. `stop`
// decides where the walk ends; `limit` caps how many commits it may collect.
// The request budget ends it too, so a returned chain may still be open at
// the bottom — callers read that off the parents.
async function walk(page, starts, stop, limit) {
  const chain = [];
  const seen = new Set();
  let wave = starts;
  while (wave.length > 0 && chain.length < limit) {
    const oids = wave
      .filter((oid) => !stop(oid) && !seen.has(oid))
      .slice(0, limit - chain.length);
    for (const oid of oids) seen.add(oid);
    const commits = await Promise.all(oids.map(page).filter(Boolean));
    chain.push(...commits);
    wave = commits.flatMap((commit) => commit.parents);
  }
  return chain;
}

/**
 * Exact branch heads plus the commits the snapshot is missing:
 * { heads, commits, fresh }. Commits carry real GitHub identities
 * (login/avatar straight from the payload — better than the git path's
 * name→login guessing). fresh is false when some moved branch could not be
 * walked at all and was reverted to its snapshot head.
 *
 * One load spends at most MAX_PAGES requests, however far the branches have
 * moved: a branch whose new commits do not reach the loaded history within
 * that budget keeps its live head and the newest commits that were fetched,
 * open at the bottom. Fetching further is the user's call (webExtend, behind
 * "Load older commits"), never something a load does on its own.
 *
 * `refs` is [{ name, oid, materialize }]. Without `materialize` a branch is
 * only walked when its head moved past the snapshot — the freshness job, and
 * the cheap default. With it, a branch whose tip is outside the loaded window
 * is pulled in as well (bounded by MAX_STUB_PAGES), which is what makes a
 * branch the user ticked in the header picker actually appear in the graph.
 *
 * onProgress is called with a running count of network fetches.
 */
export async function webFreshen(owner, repo, refs, byOid, onProgress = () => {}) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const heads = await mapLimited(refs, async (ref) => {
    const oid = await latestOid(base, ref.name);
    return {
      name: ref.name,
      snapOid: ref.oid,
      materialize: !!ref.materialize,
      oid,
      moved: !!ref.oid && !!oid && oid !== ref.oid,
    };
  });

  const { page, settle } = pager(base, onProgress);

  // A walk ends at loaded snapshot commits, or at any snapshot head: heads
  // below the loaded window are still known history, not missing commits.
  const known = new Set(refs.map((ref) => ref.oid).filter(Boolean));
  const reached = (oid) => byOid.has(oid) || known.has(oid);

  const chains = await Promise.all(
    heads.map((head) => {
      if (!head.oid) return null; // branch deleted; dropped below
      if (byOid.has(head.oid)) return []; // already drawn
      if (head.moved) {
        // Empty means the budget was gone before the head itself was fetched
        // (unless the head is a snapshot head, which needs no fetch).
        return walk(page, [head.oid], reached, Infinity)
          .then((chain) => (chain.length > 0 || known.has(head.oid) ? chain : null))
          .catch(() => null);
      }
      if (!head.materialize) return []; // unmoved and not asked for: nothing to do
      // Outside the window and explicitly selected: a bounded stub is the
      // point, so a walk that fails part-way still counts.
      return walk(page, [head.oid], (oid) => oid !== head.oid && reached(oid), MAX_STUB_PAGES)
        .catch(() => [])
        .then((chain) => (chain.length > 0 ? chain : null));
    }),
  );
  await settle();

  const commits = [];
  const spliced = new Set();
  let fresh = true;
  heads.forEach((head, i) => {
    const chain = chains[i];
    if (chain) {
      for (const commit of chain) {
        if (!spliced.has(commit.oid)) {
          spliced.add(commit.oid);
          commits.push(commit);
        }
      }
    } else if (head.oid) {
      // Nothing of the live head could be fetched: stale but consistent.
      // (A materialised branch has no snapshot head and drops out.)
      head.oid = head.snapOid;
      fresh = false;
    }
  });
  return {
    heads: heads.filter((head) => head.oid).map((head) => ({ name: head.name, oid: head.oid })),
    commits,
    fresh,
  };
}

/**
 * Continue branches that a budgeted walk left open: fetch downwards from the
 * given parent oids until the history reaches `byOid` or one of the `known`
 * snapshot heads, within one more MAX_PAGES budget. Returns the commits.
 */
export async function webExtend(owner, repo, starts, byOid, known = new Set()) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { page, settle } = pager(base, () => {});
  try {
    return await walk(page, starts, (oid) => byOid.has(oid) || known.has(oid), Infinity);
  } finally {
    await settle();
  }
}
