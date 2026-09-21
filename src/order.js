// Row order for the graph: newest-first, children always above their parents.
//
// GitHub's network array is date-ordered, so its absolute position (`idx`)
// reversed is the order layout() wants. Commits spliced in from git or from
// the commit pages have no such position, so they get a *fractional* idx
// derived from their date (chronoIndex) and are then merged into the same
// ordering. Dates alone cannot be trusted to keep a child above its parent
// (clock skew, rebases, a merge older than what it merges), and layout()
// breaks if a parent is emitted first — so the final order is decided
// topologically, using idx only to choose between commits that are ready.
//
// Pure and DOM-free so it can be unit-tested in Node.

// Local time throughout: data.js parses the chunk timestamps without a zone,
// so they are already local, and meta.dates is the day axis they sit on.
// Mixing in UTC here would put a commit in the wrong day bucket.
function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, '0')}`;
}

// Fraction of the day a date sits at, so same-day commits keep their order.
function fractionOfDay(date) {
  return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) / 86400;
}

/**
 * Where `date` belongs in GitHub's oldest-first, day-granular `meta.dates`.
 * Returns a fractional index: `n - 1 + fraction`, where n is the number of
 * days at or before it. A commit newer than the whole array therefore lands
 * above its last entry, and one older than all of it lands below index 0 —
 * both without colliding with a real array position.
 *
 * @param {string[]} dates ascending "YYYY-MM-DD" strings (meta.dates)
 */
export function chronoIndex(dates, date) {
  const valid = date instanceof Date && !isNaN(date.getTime());
  const day = valid ? isoDay(date) : '';
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1 + (valid ? fractionOfDay(date) : 0);
}

/**
 * Newest-first order for `commits` (each { oid, parents, idx }) in which no
 * commit appears after one of its own parents. Among the commits that are
 * ready (all of their loaded children already emitted) the largest idx wins,
 * so the result stays as close to chronological as the graph allows.
 *
 * @returns {Array} the same commit objects, reordered.
 */
export function orderCommits(commits) {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  // Deduped so a commit that lists the same parent twice is counted once.
  const parentsOf = new Map(commits.map((commit) => [commit.oid, [...new Set(commit.parents)]]));
  const pending = new Map(commits.map((commit) => [commit.oid, 0])); // loaded children left
  for (const commit of commits) {
    for (const parent of parentsOf.get(commit.oid)) {
      if (pending.has(parent)) pending.set(parent, pending.get(parent) + 1);
    }
  }

  // The ready frontier is the open branch tips — single digits in practice,
  // against hundreds of commits — so a linear pick beats a heap and has
  // nowhere for an index bug to hide. Ties break on oid, for determinism.
  const ready = commits.filter((commit) => pending.get(commit.oid) === 0);
  const takeNewest = () => {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i];
      const b = ready[best];
      if (a.idx !== b.idx ? a.idx > b.idx : a.oid > b.oid) best = i;
    }
    return ready.splice(best, 1)[0];
  };

  const ordered = [];
  while (ready.length > 0) {
    const commit = takeNewest();
    ordered.push(commit);
    // A commit joins `ready` only as its last child is emitted, so it can
    // never be picked twice and needs no seen-set.
    for (const parent of parentsOf.get(commit.oid)) {
      if (!pending.has(parent)) continue;
      const left = pending.get(parent) - 1;
      pending.set(parent, left);
      if (left === 0) ready.push(byOid.get(parent));
    }
  }

  // A cycle (impossible in git, but the data is third-party) would strand
  // commits; append them by idx rather than dropping rows on the floor.
  if (ordered.length < commits.length) {
    const emitted = new Set(ordered.map((commit) => commit.oid));
    const rest = commits.filter((commit) => !emitted.has(commit.oid));
    rest.sort((a, b) => b.idx - a.idx);
    ordered.push(...rest);
  }
  return ordered;
}
