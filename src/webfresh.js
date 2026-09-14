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
// per missing commit — hence the opt-in in data.js and MAX_PAGES. Only
// branches whose head moved are walked, each independently: a branch that
// fails (cap hit, endpoint change) keeps its stale-but-consistent snapshot
// head while the others still freshen.

const MAX_PAGES = 100;

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

/**
 * Exact branch heads plus the commits the snapshot is missing:
 * { heads, commits, fresh }. Commits carry real GitHub identities
 * (login/avatar straight from the payload — better than the git path's
 * name→login guessing). fresh is false when some moved branch could not be
 * walked completely and was reverted to its snapshot head.
 * onProgress is called with a running count of network fetches.
 */
export async function webFreshen(owner, repo, snapshotHeads, byOid, onProgress = () => {}) {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const heads = await mapLimited(snapshotHeads, async (head) => ({
    name: head.name,
    snapOid: head.oid,
    oid: await latestOid(base, head.name),
  }));

  // Shared memo so parallel branch walks meeting at a merge fetch a page
  // once. Cache hits are free: only network fetches count toward the cap.
  // The stray .catch marks rejections as handled for walks that die before
  // awaiting them.
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
      if (fetched >= MAX_PAGES) throw new Error('webfresh: page cap exceeded');
      fetched++;
      promise = fetchCommit(base, oid).then((commit) => {
        cache[oid] = { ...commit, date: commit.date.getTime() };
        onProgress(++done);
        return commit;
      });
      promise.catch(() => {});
    }
    pages.set(oid, promise);
    return promise;
  };

  // A walk ends at loaded snapshot commits, or at any snapshot head: heads
  // below the loaded window are still known history, not missing commits.
  const known = new Set(snapshotHeads.map((head) => head.oid));

  // Breadth-first from a moved head, each wave of parents in parallel.
  async function walk(startOid) {
    const chain = [];
    const seen = new Set();
    let wave = [startOid];
    while (wave.length > 0) {
      const oids = wave.filter((oid) => !byOid.has(oid) && !known.has(oid) && !seen.has(oid));
      for (const oid of oids) seen.add(oid);
      const commits = await Promise.all(oids.map(page));
      chain.push(...commits);
      wave = commits.flatMap((commit) => commit.parents);
    }
    return chain;
  }

  const chains = await Promise.all(
    heads.map((head) => {
      if (!head.oid) return null; // branch deleted; dropped below
      if (head.oid === head.snapOid || byOid.has(head.oid)) return []; // nothing missing
      return walk(head.oid).catch(() => null);
    }),
  );
  // A walk that hits the cap mid-wave dies with that wave's earlier fetches
  // still in flight. Let them land before returning: otherwise their progress
  // ticks arrive after the graph is drawn and repaint the loading screen over
  // it, and their commits miss the cache write below.
  await Promise.allSettled(pages.values());
  if (fetched > 0) saveCache(cache); // partial walks too: retries resume deeper

  const commits = [];
  const spliced = new Set();
  let fresh = true;
  heads.forEach((head, i) => {
    if (chains[i]) {
      for (const commit of chains[i]) {
        if (!spliced.has(commit.oid)) {
          spliced.add(commit.oid);
          commits.push(commit);
        }
      }
    } else if (head.oid) {
      head.oid = head.snapOid; // walk failed: stale but consistent
      fresh = false;
    }
  });
  return {
    heads: heads.filter((head) => head.oid).map((head) => ({ name: head.name, oid: head.oid })),
    commits,
    fresh,
  };
}
