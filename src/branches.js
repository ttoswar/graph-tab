// Which branches the graph draws.
//
// The network-graph snapshot is a window over the whole fork network, so a
// branch whose tip happens to fall outside that window has to be pulled in
// separately (one git fetch, or one page per commit on a private repo).
// Doing that for every branch of every repository would be slow and is not
// what most people want to look at, so the set is a choice:
//
//   - by default the graph draws the default branch plus every branch the
//     snapshot window already contains — exactly what the old behaviour
//     showed, at exactly the old cost (no extra request);
//   - ticking more branches in the header picker pulls them in and keeps
//     that choice for the repository.
//
// Selections are per repository (localStorage, like the column widths). A
// missing entry means "auto", so a repository that later grows a branch
// still picks it up.

const KEY = 'ggt-branches';

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

/** Stored branch names for a repository, or null when the user never chose. */
export function loadSelection(owner, repo) {
  const names = read()[`${owner}/${repo}`];
  return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : null;
}

/** Persist a choice; `null` restores the automatic default. */
export function saveSelection(owner, repo, names) {
  const all = read();
  if (names === null) delete all[`${owner}/${repo}`];
  else all[`${owner}/${repo}`] = [...names];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable; the choice just won't stick
  }
}

/**
 * The branches to draw, as a Set of names.
 *
 * @param stored     loadSelection() result, or null for automatic
 * @param branches   [{ name, oid }] every branch the repository has
 * @param defaultBranch name of the repository's default branch, if known
 * @param isLoaded   (oid) => true when that commit is already in the window
 */
export function resolveSelection(stored, branches, defaultBranch, isLoaded) {
  const existing = new Set(branches.map((branch) => branch.name));
  const hasDefault = !!defaultBranch && existing.has(defaultBranch);
  if (stored) {
    // Branches can be deleted between visits; drop the ones that are gone.
    const kept = new Set(stored.filter((name) => existing.has(name)));
    // The default branch is always drawn (it owns lane 0), whatever was stored.
    if (hasDefault) kept.add(defaultBranch);
    if (kept.size > 0) return kept;
  }
  const auto = new Set(branches.filter((branch) => isLoaded(branch.oid)).map((b) => b.name));
  if (hasDefault) auto.add(defaultBranch);
  // A repository whose every tip sits outside the window would otherwise
  // render empty; fall back to showing all of them.
  return auto.size > 0 ? auto : existing;
}
