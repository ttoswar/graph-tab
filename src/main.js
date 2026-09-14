// Entry point: keep the Graph tab present on repo pages across GitHub's
// soft (turbo/React) navigations, and swap the repo content for the graph
// view whenever the URL says so. The #graph hash is the source of truth —
// the tab click just pushes it — so refresh (the server never sees a hash),
// back/forward, and pasted links all land on the graph.

import { ensureTab, markTabSelected, markTabDeselected, repoNav, TAB_ID } from './tab.js';
import { openRepoGraph } from './data.js';
import { layout } from './layout.js';
import { render, renderStatus, closeBranchPicker, markViewBusy } from './render.js';
import { maybeWelcome } from './welcome.js';

const VIEW_ID = 'ggt-view';
const GRAPH_HASH = '#graph';

// GitHub's non-repository top-level routes; everything else shaped like
// /{owner}/{repo} is treated as a repo (the nav lookup is the real gate).
const RESERVED = new Set([
  'settings', 'notifications', 'explore', 'marketplace', 'sponsors', 'topics',
  'collections', 'trending', 'features', 'organizations', 'orgs', 'enterprises',
  'login', 'logout', 'join', 'signup', 'new', 'codespaces', 'search', 'pulls',
  'issues', 'dashboard', 'apps', 'account', 'about', 'contact', 'pricing',
]);

let source = null;    // data source for the current repo
let hidden = [];      // elements we hid to show the view; restored on close
let lastHref = null;
let hydrationRetry = 0;

function repoFromPath() {
  const [owner, repo] = location.pathname.split('/').filter(Boolean);
  if (!owner || !repo || RESERVED.has(owner)) return null;
  return { owner, repo };
}

function contentFrame() {
  return (
    document.querySelector('turbo-frame#repo-content-turbo-frame') ||
    document.querySelector('#js-repo-pjax-container') ||
    document.querySelector('main')
  );
}

function closeGraphView() {
  // The picker's menu lives on document.body, so it has to be taken down
  // explicitly — removing the view would otherwise leave it floating.
  closeBranchPicker();
  document.getElementById(VIEW_ID)?.remove();
  for (const element of hidden) {
    if (element.isConnected) element.style.removeProperty('display');
  }
  hidden = [];
  markTabDeselected();
}

function openGraphView() {
  const repoRef = repoFromPath();
  const frame = contentFrame();
  if (!repoRef || !frame) return;

  markTabSelected();

  let view = document.getElementById(VIEW_ID);
  if (!view) {
    view = document.createElement('div');
    view.id = VIEW_ID;
    if (frame.tagName === 'MAIN') {
      // Hiding <main> could hide the nav itself; hide its children instead.
      hidden = [...frame.children].filter((child) => child.style.display !== 'none');
      frame.appendChild(view);
    } else {
      hidden = [frame];
      frame.before(view);
    }
    for (const element of hidden) element.style.display = 'none';
  }

  loadAndRender(view, repoRef);
}

async function loadAndRender(view, repoRef) {
  try {
    if (!source || source.owner !== repoRef.owner || source.repo !== repoRef.repo) {
      renderStatus(view, repoRef, 'Loading the newest commits…', {
        busy: true,
        detail: 'GitHub may need a moment to generate graph data for this repository.',
      });
      // Progress may only paint while this load is still the one in flight:
      // a tick after it settles would cover the drawn graph with the loading
      // screen again.
      let settled = false;
      try {
        source = await openRepoGraph(repoRef.owner, repoRef.repo, (count) => {
          if (settled) return;
          renderStatus(view, repoRef, `Fetching fresh commits… ${count}`, {
            busy: true,
            detail: 'One small request per missing commit; fetched commits are cached on this device.',
          });
        });
      } finally {
        settled = true;
      }
    }
    rerender(view);
    maybeWelcome();
  } catch (error) {
    source = null;
    renderStatus(view, repoRef, String(error.message || error), {
      error: true,
      onRetry: () => loadAndRender(view, repoRef),
    });
  }
}

function rerender(view) {
  const { commits, filtered } = source.view();
  // Reloading via a fresh source re-fetches meta (new nethash) and re-runs
  // freshen(); used by the Refresh button.
  const reload = () => {
    const repoRef = { owner: source.owner, repo: source.repo };
    source = null;
    loadAndRender(view, repoRef);
  };
  render(view, {
    owner: source.owner,
    repo: source.repo,
    commits,
    graph: layout(commits, { pinnedOid: source.pinnedOid }),
    heads: source.heads,
    branches: source.branches,
    selected: source.selected,
    defaultBranch: source.defaultBranch,
    truncated: source.truncated,
    canFetch: source.canFetch,
    tags: source.tags,
    fresh: source.fresh,
    filtered,
    total: source.total,
    loaded: source.loaded(),
    olderCount: source.olderCount(),
    failedWindows: source.failedWindows(),
    hasMore: source.hasMore(),
    onRefresh: reload,
    onLoadOlder: async () => {
      markViewBusy(view);
      await source.loadOlder();
      rerender(view);
    },
    // Adding branches only ever adds commits, so the loaded window survives:
    // no meta/chunk refetch, just the pull for the newly ticked branches.
    onSelectBranches: async (names) => {
      markViewBusy(view);
      await source.selectBranches(names);
      rerender(view);
    },
  });
}

// Runs on every DOM settle and history event: syncs the view with the URL
// (open on #graph, closed otherwise; a path change drops the per-repo
// source) and re-adds the tab when GitHub re-renders the nav.
function ensure() {
  const repoRef = repoFromPath();
  const wantGraph = repoRef !== null && location.hash === GRAPH_HASH;
  const href = location.pathname + location.search + location.hash;
  if (href !== lastHref) {
    if (lastHref !== null && lastHref.split(/[?#]/, 1)[0] !== location.pathname) source = null;
    lastHref = href;
    if (!wantGraph) closeGraphView();
  }
  if (wantGraph) {
    // (Re)assert on every settle: GitHub re-renders can wipe the selection.
    if (document.getElementById(VIEW_ID)) markTabSelected();
    else openGraphView();
  }
  if (repoRef && !document.getElementById(TAB_ID) && repoNav()) {
    const tab = ensureTab(() => {
      if (location.hash !== GRAPH_HASH) history.pushState(null, '', GRAPH_HASH);
      ensure();
    });
    // A declined insert means the nav's React island is still hydrating.
    // Hydration changes no DOM, so the MutationObserver alone might never
    // see it finish — poll until the tab goes in.
    if (!tab) {
      clearTimeout(hydrationRetry);
      hydrationRetry = setTimeout(ensure, 250);
    }
  }
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    ensure();
  });
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('turbo:load', ensure);
addEventListener('hashchange', ensure);
addEventListener('popstate', ensure);
ensure();
