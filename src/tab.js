// The "Graph" item in the repository navigation bar. The markup is our own,
// but class names are copied from a sibling tab at insert time, so the tab
// matches GitHub's current styling exactly (classic UnderlineNav and the
// logged-in React nav alike) without hardcoding churn-prone class names.
// Our own CSS (.ggt-nav*) only kicks in if there is no sibling to copy from.

import { octicon } from './octicon.js';

export const TAB_ID = 'ggt-tab';

const NAV_SELECTORS = [
  'nav[aria-label="Repository"] ul',
  'ul[class*="UnderlineItemList"]',
  'nav[class*="LocalNavigation"] ul',
];

export function repoNav() {
  for (const selector of NAV_SELECTORS) {
    const nav = document.querySelector(selector);
    if (nav) return nav;
  }
  return null;
}

// GitHub renders the logged-in nav as a React island (<react-partial
// partial-name="global-nav-bar">, SSR'd then hydrated) that also contains
// the header search box. Inserting a foreign <li> before hydration makes
// React treat the whole island as a hydration mismatch: it discards the
// server DOM and re-renders client-side (data-ssr flips to "false"), which
// silently drops the server-only <qbsearch-input> internals — the search
// box then dies on first click. GitHub adds class="loaded" to the island
// once React has finished mounting (verified to land after hydration), and
// unlike React's fiber expandos a class is visible from the content-script
// world — so until it shows up, leave the nav alone (main.js retries). The
// timeout is a safety valve: if "loaded" never comes (GitHub renames it,
// React crashed on its own), a late insert is harmless and beats never
// showing the tab.
let pendingSince = 0;
function hydrationPending(nav) {
  const root = nav.closest('react-app, react-partial');
  if (!root || root.classList.contains('loaded')) {
    pendingSince = 0;
    return false;
  }
  pendingSince ||= Date.now();
  return Date.now() - pendingSince < 8000;
}

// Copy presentation classes from a sibling element, skipping GitHub's
// behavior/state classes (js-* hooks, selection, icon-specific octicons).
// Returns false when nothing was copied so the caller can fall back.
function copyClasses(source, target) {
  if (!source) return false;
  const names = [...source.classList].filter(
    (name) => !name.startsWith('js-') && !name.startsWith('octicon-') && name !== 'selected'
  );
  if (names.length === 0) return false;
  target.classList.add(...names);
  return true;
}

/** Insert the Graph tab into the repo nav if missing. Returns the anchor. */
export function ensureTab(onOpen) {
  const existing = document.getElementById(TAB_ID);
  if (existing) return existing;
  const nav = repoNav();
  if (!nav || hydrationPending(nav)) return null;

  const siblingLink = nav.querySelector('li a');
  const item = document.createElement('li');
  if (!copyClasses(siblingLink?.closest('li'), item)) item.className = 'ggt-navitem';

  const link = document.createElement('a');
  link.id = TAB_ID;
  if (!copyClasses(siblingLink, link)) link.className = 'ggt-navtab';
  link.href = '#graph';
  link.addEventListener('click', (event) => {
    // Modified clicks (new tab/window) keep the default: the relative
    // "#graph" href resolves against the current page URL, which is exactly
    // the link such a click should open.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  });

  // octicon() already carries GitHub's own presentation attributes; the
  // sibling's classes go on top (copyClasses drops its octicon-* names).
  const icon = octicon('git-branch');
  copyClasses(siblingLink?.querySelector('svg'), icon);

  // Primer's current UnderlineNav styles its icon through this component
  // slot. Without the wrapper the icon inherits the link's darker color and
  // loses the native 8px gap before the label, making it look too heavy.
  const iconSlot = document.createElement('span');
  iconSlot.setAttribute('data-component', 'icon');
  iconSlot.appendChild(icon);

  // data-content lets GitHub's CSS reserve the bold width, so the tab does
  // not shift when it becomes selected; our fallback CSS mirrors the trick.
  const label = document.createElement('span');
  copyClasses(siblingLink?.querySelector('span[data-content]'), label);
  label.setAttribute('data-component', 'text');
  label.setAttribute('data-content', 'Graph');
  label.textContent = 'Graph';

  link.appendChild(iconSlot);
  link.appendChild(label);
  item.appendChild(link);
  nav.appendChild(item);
  return link;
}

// GitHub links we stole aria-current from, so closing the view (a hash-only
// change, which GitHub does not re-render on) can hand the selection back.
let displaced = [];

/** Mark our tab current and visually deselect GitHub's own tabs. */
export function markTabSelected() {
  const tab = document.getElementById(TAB_ID);
  if (!tab) return;
  tab.setAttribute('aria-current', 'page');
  const nav = repoNav();
  if (!nav) return;
  for (const link of nav.querySelectorAll('a[aria-current]')) {
    if (link !== tab) {
      displaced.push({ link, selected: link.classList.contains('selected') });
      link.removeAttribute('aria-current');
      link.classList.remove('selected');
    }
  }
}

/** Undo markTabSelected. No-ops for links GitHub has since re-rendered. */
export function markTabDeselected() {
  document.getElementById(TAB_ID)?.removeAttribute('aria-current');
  for (const { link, selected } of displaced) {
    if (!link.isConnected) continue;
    link.setAttribute('aria-current', 'page');
    if (selected) link.classList.add('selected');
  }
  displaced = [];
}
