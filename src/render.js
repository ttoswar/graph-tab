// DOM/SVG renderer. Consumes the pure layout() output: one <svg> for the
// whole graph column, absolutely positioned over fixed-height HTML rows
// (vscode-git-graph's structural model). Curved lane transitions use the
// same cubic-bezier shape as vscode-git-graph. Colors come from a fixed
// palette; text and chrome use GitHub's CSS variables so both themes work.
//
// Everything sits inside a bordered "shell" styled like GitHub's own boxed
// lists: a muted toolbar (title, counts subtitle, actions), status banners,
// the graph, and a muted footer with the pagination button.

import { initColumns } from './columns.js';
import { octicon } from './octicon.js';

const ROW_H = 28;
const LANE_W = 14;
const PAD_X = 12;
const MAX_LANES = 20; // graph column width cap; wider histories are clipped

const PALETTE = [
  '#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000',
  '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function colorOf(index) {
  return PALETTE[index % PALETTE.length];
}

function px(x) {
  return PAD_X + x * LANE_W;
}

function py(y) {
  return y * ROW_H + ROW_H / 2;
}

function relTime(date) {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  if (seconds < 30 * 86400) return Math.floor(seconds / 86400) + 'd';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

function buildSvg(graph, headOids, commits) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const width = PAD_X + Math.min(graph.laneCount, MAX_LANES) * LANE_W;
  svg.setAttribute('class', 'ggt-svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(graph.nodes.length * ROW_H));

  for (const seg of graph.segments) {
    const x1 = px(seg.x1), y1 = py(seg.y1);
    const x2 = px(seg.x2), y2 = py(seg.y2);
    let d;
    if (seg.x1 === seg.x2) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      const c = (y2 - y1) * 0.8;
      d = `M ${x1} ${y1} C ${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', colorOf(seg.color));
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    if (seg.dashed) {
      path.setAttribute('stroke-dasharray', '3,3');
      path.setAttribute('opacity', '0.55');
    }
    svg.appendChild(path);
  }

  graph.nodes.forEach((node, i) => {
    const cx = String(px(node.x));
    const cy = String(py(node.row));
    const color = colorOf(node.color);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);
    if (headOids.has(commits[i].oid)) {
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', cx);
      ring.setAttribute('cy', cy);
      ring.setAttribute('r', '6');
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', '1.5');
      svg.appendChild(ring);
    }
  });

  return { svg, width };
}

// The framed box with its toolbar: title plus the muted subtitle under it.
function buildShell(subtitle) {
  const shell = el('section', 'ggt-shell');
  const toolbar = el('div', 'ggt-toolbar');
  const titles = el('div', 'ggt-titles');
  titles.appendChild(el('h2', 'ggt-title', 'Commit graph'));
  if (subtitle) titles.appendChild(el('span', 'ggt-subtitle', subtitle));
  toolbar.appendChild(titles);
  shell.appendChild(toolbar);
  return { shell, toolbar };
}

// The branch picker: which branches the graph draws.
//
// Structure and metrics are GitHub's SelectPanel — the control behind its
// repository and branch dropdowns — measured off the live component rather
// than guessed: a 320px/12px-radius overlay holding a header (8px 8px 0, a
// 14px/21px 600 title), a filter row (a 304x32 muted input with 8px margin
// and 6px radius), and a list (8px 0 padding, rows 32px tall at 0 8px with a
// 6px radius, whose content sits at 6px 8px behind a 16px selection slot and
// a 16px leading visual, each with 8px to its right).
//
// Those numbers are hard-coded here rather than borrowed through Primer's
// class names, because GitHub code-splits its CSS: on a plain repository page
// none of the `prc-ActionList-*` / `prc-SelectPanel-*` rules are loaded at
// all (checked — every one of them missing until GitHub's own picker mounts).
// Carrying the class names looked right only when the chunk happened to be
// there, and would fight our own rules when it was. The `data-component`
// attributes are kept: they carry no styling, and they say what each part is.
//
// The two bulk actions live in the header as a Primer SegmentedControl
// ("Default | All"), not as rows in the list: they act on the whole list, so
// putting them at the same level as the branches they control read as a
// mistake — and GitHub itself puts the one switch its branch panel has
// (Branches | Tags) above the list, never inside it. Two named segments also
// avoid the lie a select-all checkbox would tell here: a graph has to draw
// at least one branch, so "unchecked" has no honest meaning. Hand-picking
// leaves neither segment active, which is exactly what "custom" looks like.
//
// Two behaviours matter beyond the looks:
//
//   - The overlay is fixed-positioned on document.body, anchored to the
//     button. Inside the graph shell it would be part of the toolbar's layout
//     and clipped by the shell's overflow.
//   - A click applies straight away. No Apply and no close button: the bulk
//     actions are the header switch above, and an outside click or Escape
//     closes the menu.
//
// The stylesheet is injected from here rather than shipped in style.css: the
// manifest injects that one and only refreshes it when the extension is
// reloaded, while these modules are re-read on every page load, so after an
// update the JS would otherwise run against last version's CSS.
//
// Applying re-renders the whole view, which rebuilds this control, so the
// open state and the filter text live at module scope and are restored.

// Banners the user closed, keyed by repository and text. The view is rebuilt
// on every render, so this has to outlive it; a banner whose text changes
// (another branch cut short, one more failed window) is news and shows again.
const dismissedBanners = new Set();

// A dismissible status banner, or null when this one was already closed.
// GitHub's own full-width flash, markup and class names as GitHub renders it
// (close button first, floated right): primer.css styles it on every
// repository page, so it looks and themes exactly like GitHub's banners.
// The close has no js-flash-close — dismissal is remembered here instead.
function banner(repoKey, text, error = false) {
  const key = `${repoKey}\n${text}`;
  if (dismissedBanners.has(key)) return null;
  const node = el('div', `flash flash-full ${error ? 'flash-error' : 'flash-warn'}`);
  const close = el('button', 'flash-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss this message');
  close.appendChild(octicon('x'));
  close.addEventListener('click', () => {
    dismissedBanners.add(key);
    node.remove();
  });
  node.append(close, text);
  return node;
}

const PANEL_WIDTH = 320;
let panelOpen = false;
let panelFilter = '';
let livePanel = null;
// Listeners the open overlay puts on document/window. A stale outside-click
// handler whose panel is already detached sees every click as "outside" and
// shuts the new menu, so the previous instance has to hand these back.
let detachPanel = null;

const UI_STYLE_ID = 'ggt-ui-style';

// Primer's own rules, lifted verbatim from GitHub's stylesheet
// (github.githubassets.com/assets/primer-react-css.e93836c189a090d0.module.css)
// with only the selectors renamed: prc-Overlay-Overlay -> .ggt-panel,
// prc-SelectPanel-* -> .ggt-sp-*, prc-FilteredActionList-* -> .ggt-fal-*,
// prc-ActionList-* -> .ggt-item/.ggt-sub/..., prc-SegmentedControl-* ->
// .ggt-seg-*, prc-components-TextInput* -> .ggt-input. Declarations,
// custom properties and fallbacks are untouched, so the control is GitHub's
// rather than an imitation of it, and it follows both themes.
//
// They have to be shipped rather than borrowed: GitHub code-splits this
// stylesheet, and on a plain repository page none of it is loaded until one
// of GitHub's own menus mounts. Refresh by re-running the extraction against
// the current asset URL.
const UI_CSS = `
/* Overlay */
.ggt-panel { background-color: var(--overlay-bgColor, #fff); border-radius: var(--borderRadius-large, .75rem);
  box-shadow: var(--shadow-floating-small, 0 0 0 1px #d1d9e080, 0 6px 12px -3px #25292e0a, 0 6px 18px 0 #25292e1f);
  height: auto; overflow: hidden; outline: 1px solid #0000;
  /* Primer anchors its overlay with CSS anchor positioning; this one is
     placed against the button by place(), so it is fixed to the viewport and
     sized here rather than by Primer's min/max-width pair. */
  position: fixed; z-index: 1000; width: ${PANEL_WIDTH}px; }
.ggt-panel:focus { outline: none; }
.ggt-panel[hidden] { display: none; }
.ggt-panel[aria-busy="true"] { pointer-events: none; }

/* SelectPanel */
.ggt-sp { height: inherit; max-height: inherit; flex-direction: column; display: flex; }
.ggt-sp-head { padding-left: var(--base-size-8, .5rem); padding-right: var(--base-size-8, .5rem);
  padding-top: var(--base-size-8, .5rem); justify-content: space-between; align-items: flex-start; display: flex; }
.ggt-sp-title { font-size: var(--text-body-size-medium, .875rem); margin: var(--base-size-8, .5rem) 0 0 var(--base-size-8, .5rem); }

/* FilteredActionList */
.ggt-fal { flex-direction: column; display: flex; overflow: hidden; height: inherit; max-height: inherit; }
.ggt-fal-head { box-shadow: 0 1px 0 var(--borderColor-default, #d1d9e0); z-index: 1; }
.ggt-fal-body { flex-grow: 1; height: 100%; display: flex; overflow: auto; }

/* TextInput */
.ggt-input { background-color: var(--bgColor-default, #fff);
  border: var(--borderWidth-thin, .0625rem) solid var(--control-borderColor-rest, #d1d9e0);
  border-radius: var(--borderRadius-medium, .375rem); box-shadow: var(--shadow-inset, inset 0 1px 0 0 #1f23280a);
  color: var(--fgColor-default, #1f2328); cursor: text; font-size: var(--text-body-size-medium, .875rem);
  line-height: var(--base-size-20, 1.25rem); min-height: var(--base-size-32, 2rem); vertical-align: middle;
  outline: none; align-items: stretch; display: flex; overflow: hidden;
  margin: var(--base-size-8, .5rem); align-self: stretch; }
.ggt-input:where([data-contrast]) { background-color: var(--control-bgColor-contrast, var(--bgColor-inset, #f6f8fa)); }
.ggt-input:focus-within { border-color: var(--borderColor-accent-emphasis, #0969da);
  outline: var(--borderWidth-thick, .125rem) solid var(--borderColor-accent-emphasis, #0969da); outline-offset: -1px; }
.ggt-input .ggt-input-icon { display: flex; align-items: center; padding-left: 8px; color: var(--fgColor-muted, #59636e); }
.ggt-input input { appearance: none; color: inherit; font-family: inherit; font-size: inherit;
  background-color: #0000; border: 0; width: 100%; padding: 0 8px; outline: none; }

/* ActionList */
.ggt-list { margin: 0; padding: 0; list-style: none; flex-grow: 1; }
.ggt-list:where([data-variant=inset]) { padding-block: var(--base-size-8, .5rem); }
.ggt-list:where([data-variant=inset]) .ggt-item { margin-inline: var(--base-size-8, .5rem); }
.ggt-list:where([data-dividers=true]) .ggt-sub:before { background: var(--borderColor-muted, #d1d9e0b3); content: "";
  width: 100%; height: 1px; display: block; position: absolute; top: -7px; }
.ggt-list:where([data-dividers=true]) .ggt-item:first-of-type .ggt-sub:before { visibility: hidden; }
.ggt-item { background-color: var(--control-transparent-bgColor-rest, #fff0);
  border-radius: var(--borderRadius-medium, .375rem); list-style: none; position: relative; }
.ggt-item:not([aria-disabled=true]):hover { cursor: pointer; background-color: var(--control-transparent-bgColor-hover, #818b981a); }
.ggt-item:focus-visible { box-shadow: none; outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 0; }
.ggt-item:not([aria-disabled=true]):hover .ggt-sub:before,
.ggt-item:not([aria-disabled=true]):hover + .ggt-item .ggt-sub:before,
.ggt-item:focus-visible .ggt-sub:before,
.ggt-item:focus-visible + .ggt-item .ggt-sub:before,
.ggt-item:where([data-is-active-descendant]) .ggt-sub:before,
.ggt-item:where([data-is-active-descendant]) + .ggt-item .ggt-sub:before { visibility: hidden; }
.ggt-item:where([data-is-active-descendant]) { background: var(--control-transparent-bgColor-selected, #818b9826); outline: 2px solid #0000; }
.ggt-item:where([data-is-active-descendant]):after { background: var(--borderColor-accent-emphasis, #0969da);
  border-radius: var(--borderRadius-medium, .375rem); content: ""; height: calc(100% - var(--base-size-8, .5rem));
  left: calc(var(--base-size-8, .5rem)*-1); top: var(--base-size-4, .25rem); width: var(--base-size-4, .25rem); position: absolute; }
.ggt-item[aria-disabled=true] .ggt-item-content * { color: var(--control-fgColor-disabled, #818b98); }
.ggt-item[aria-disabled=true]:hover, .ggt-item[aria-disabled=true] .ggt-item-content:hover { cursor: not-allowed; background-color: #0000; }
.ggt-item-content { border-radius: var(--borderRadius-medium, .375rem); color: var(--control-fgColor-rest, #25292e);
  padding-block: var(--control-medium-paddingBlock, .375rem); padding-inline: var(--control-medium-paddingInline-condensed, .5rem);
  text-align: left; touch-action: manipulation; user-select: none; background-color: #0000; border: none;
  grid-template: "leadingAction leadingVisual content" min-content / min-content min-content minmax(0, auto);
  align-items: start; width: 100%; transition: background 33.333ms linear; display: grid; position: relative; }
.ggt-item-content > :not(:last-child) { margin-right: var(--control-medium-gap, .5rem); }
.ggt-item-content:hover { cursor: pointer; text-decoration: none; }
.ggt-sel { grid-area: leadingAction; }
.ggt-vis { grid-area: leadingVisual; }
.ggt-sel, .ggt-vis { min-height: var(--base-size-20, 1.25rem); pointer-events: none; min-width: max-content;
  color: var(--fgColor-muted, #59636e); fill: var(--fgColor-muted, #59636e); align-items: center; line-height: 20px; display: flex; }
.ggt-item[aria-selected="false"] .ggt-sel svg { visibility: hidden; }
.ggt-sub { grid-template: "label trailingVisual" min-content / minmax(0, auto) min-content; grid-area: content;
  align-items: center; width: 100%; display: grid; position: relative; }
.ggt-sub > :not(:last-child) { margin-right: var(--control-medium-gap, .5rem); }
.ggt-label { color: var(--fgColor-default, #1f2328); font-size: var(--text-body-size-medium, .875rem);
  font-weight: var(--base-text-weight-normal, 400); grid-area: label; line-height: 20px; position: relative;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ggt-row-pill { grid-area: trailingVisual; padding: 0 7px; font-size: var(--text-body-size-small, .75rem);
  font-weight: var(--base-text-weight-medium, 500); line-height: 18px; color: var(--fgColor-muted, #59636e);
  border: var(--borderWidth-thin, .0625rem) solid var(--borderColor-default, #d1d9e0); border-radius: 2em; white-space: nowrap; }
.ggt-row-pill-fetch { color: var(--fgColor-attention, #9a6700); border-color: var(--borderColor-attention-muted, #d4a72c66); }
.ggt-list-empty { padding: 6px 16px 10px; color: var(--fgColor-muted, #59636e); list-style: none; }

/* SegmentedControl */
.ggt-seg { --segmented-control-icon-width: 32px; background-color: var(--controlTrack-bgColor-rest, #e6eaef);
  border: var(--borderWidth-thin, .0625rem) solid var(--controlTrack-borderColor-rest, transparent);
  border-radius: var(--borderRadius-medium, .375rem); font-size: var(--text-body-size-medium, .875rem);
  height: 32px; margin: 0; padding: 0; display: inline-flex; list-style: none; }
.ggt-seg:where([data-size=small]) { font-size: var(--text-body-size-small, .75rem); height: 28px; }
.ggt-seg-item { flex-grow: 1; margin-top: -1px; margin-bottom: -1px; display: block; position: relative; list-style: none; }
.ggt-seg-item:not(:last-child) { margin-right: 1px; }
.ggt-seg-item:not(:last-child):after { background-color: var(--borderColor-default, #d1d9e0);
  bottom: var(--base-size-8, .5rem); content: ""; right: calc(var(--base-size-2, .125rem)*-1);
  top: var(--base-size-8, .5rem); width: 1px; position: absolute; }
.ggt-seg-item:not(:last-child):has(+ [data-selected]):after,
.ggt-seg-item:not(:last-child):where([data-selected]):after { background-color: #0000; }
.ggt-seg-item:first-child { margin-left: -1px; }
.ggt-seg-item:last-child { margin-right: -1px; }
.ggt-seg-btn { --segmented-control-button-inner-padding: 12px; --segmented-control-button-bg-inset: 4px;
  --segmented-control-outer-radius: var(--borderRadius-medium, .375rem); border-radius: var(--segmented-control-outer-radius);
  color: currentColor; cursor: pointer; font-family: inherit; font-size: inherit;
  font-weight: var(--base-text-weight-normal, 400); height: 100%; padding: var(--segmented-control-button-bg-inset);
  background-color: #0000; border-width: 0; border-color: #0000; width: 100%; }
.ggt-seg-btn:focus-visible:not(:disabled) { box-shadow: none;
  outline: var(--base-size-2, .125rem) solid var(--fgColor-accent, #0969da); outline-offset: -1px; }
.ggt-seg-content { border-radius: calc(var(--segmented-control-outer-radius) - var(--segmented-control-button-bg-inset)/2);
  border-style: solid; border-color: #0000; border-width: var(--borderWidth-thin, .0625rem); height: 100%;
  padding-left: calc(var(--segmented-control-button-inner-padding) - var(--segmented-control-button-bg-inset));
  padding-right: calc(var(--segmented-control-button-inner-padding) - var(--segmented-control-button-bg-inset));
  justify-content: center; align-items: center; display: flex; }
.ggt-seg-btn[aria-pressed=true] { font-weight: var(--base-text-weight-semibold, 600); padding: 0; }
.ggt-seg-btn[aria-pressed=true] .ggt-seg-content { background-color: var(--controlKnob-bgColor-rest, #fff);
  border-color: var(--controlKnob-borderColor-rest, #d1d9e0); border-radius: var(--segmented-control-outer-radius);
  padding-left: var(--segmented-control-button-inner-padding); padding-right: var(--segmented-control-button-inner-padding); }
.ggt-seg-btn:not([aria-pressed=true]):hover .ggt-seg-content { background-color: var(--controlTrack-bgColor-hover, #e0e6eb); }
.ggt-seg-btn:not([aria-pressed=true]):active .ggt-seg-content { background-color: var(--controlTrack-bgColor-active, #dae0e7); }
.ggt-seg-text { position: relative; }
.ggt-seg-text:after { content: attr(data-text); font-weight: var(--base-text-weight-semibold, 600);
  pointer-events: none; user-select: none; visibility: hidden; height: 0; display: block; overflow: hidden; }

/* Anchor button: .ggt-btn (style.css) is already Primer's medium button, so
   only the slot layout and the counter belong here. */
.ggt-select-btn { gap: 8px; white-space: nowrap; }
.ggt-select-btn svg { flex: none; color: var(--fgColor-muted, #59636e); }
.ggt-counter { padding: 0 6px; font-size: var(--text-body-size-small, .75rem); font-weight: var(--base-text-weight-medium, 500);
  line-height: 18px; color: var(--fgColor-default, #1f2328); background: var(--bgColor-neutral-muted, #818b981f); border-radius: 2em; }

/* Ours: picking a branch takes a round trip and then replaces the whole
   view, so the click is answered at once and the new graph fades up out of
   the dim rather than cutting. */
.ggt-shell.ggt-busy .ggt-wrap, .ggt-shell.ggt-busy .ggt-footer { opacity: .5; transition: opacity .12s ease-out; }
.ggt-busy-bar { position: absolute; left: 0; right: 0; top: 0; height: 2px; overflow: hidden;
  background: var(--bgColor-neutral-muted, #818b981f); }
.ggt-busy-bar::after { content: ""; position: absolute; inset: 0; width: 40%;
  background: var(--borderColor-accent-emphasis, #0969da); border-radius: 2px; animation: ggt-busy-slide 1.1s ease-in-out infinite; }
@keyframes ggt-busy-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
.ggt-spinner { display: inline-block; width: 16px; height: 16px; box-sizing: border-box; border: 2px solid currentColor;
  border-top-color: transparent; border-radius: 50%; animation: ggt-spin .7s linear infinite; }
@keyframes ggt-spin { to { transform: rotate(360deg); } }
.ggt-item-busy .ggt-sel svg { visibility: visible; animation: ggt-pulse 1s ease-in-out infinite; }
@keyframes ggt-pulse { 50% { opacity: .25; } }
.ggt-fade-in { animation: ggt-fade .16s ease-out; }
@keyframes ggt-fade { from { opacity: .5; } to { opacity: 1; } }
`;

function ensureUiStyle() {
  if (document.getElementById(UI_STYLE_ID)) return;
  const style = el('style');
  style.id = UI_STYLE_ID;
  style.textContent = UI_CSS;
  document.head.appendChild(style);
}

/**
 * Show that a pick is being fetched, without taking the graph away: the
 * anchor button spins, a progress bar rides the top of the frame and the
 * rows dim. There is no "off": the state lasts until the data lands, and
 * render() clears it by rebuilding the subtree.
 */
export function markViewBusy(container) {
  const shell = container.querySelector('.ggt-shell');
  if (!shell) return;
  shell.classList.add('ggt-busy');
  shell.appendChild(el('div', 'ggt-busy-bar'));
  const visual = container.querySelector('.ggt-select-btn [data-component="leadingVisual"]');
  if (!visual) return;
  visual.textContent = '';
  visual.appendChild(el('span', 'ggt-spinner'));
}

/** Count fetched commits on the pill while the drawn graph is being updated. */
export function setUpdateProgress(container, count) {
  const pill = container.querySelector('.ggt-pill');
  if (pill) pill.textContent = `Updating… ${count}`;
}

/** Drop the overlay — the view is going away and it lives on document.body. */
export function closeBranchPicker() {
  detachPanel?.();
  detachPanel = null;
  livePanel?.remove();
  livePanel = null;
  panelOpen = false;
  panelFilter = '';
}

function buildBranchPicker(model) {
  const { branches, selected, defaultBranch, onSelectBranches, canFetch } = model;
  detachPanel?.();
  detachPanel = null;
  livePanel?.remove();

  const counter = el('span', 'ggt-counter', `${selected.size}/${branches.length}`);
  const button = el('button', 'ggt-btn ggt-select-btn');
  button.type = 'button';
  button.setAttribute('data-component', 'Button');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Choose which branches the graph draws';
  const leading = el('span');
  leading.setAttribute('data-component', 'leadingVisual');
  leading.appendChild(octicon('git-branch'));
  button.append(leading, el('span', null, 'Branches'), counter, octicon('triangle-down'));

  const panel = el('div', 'ggt-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Select branches');
  livePanel = panel;

  // Overlay > SelectPanel > (Header, FilteredActionList > (Header, Container))
  const wrapper = el('div', 'ggt-sp');
  wrapper.setAttribute('data-component', 'SelectPanel');
  panel.appendChild(wrapper);

  const head = el('div', 'ggt-sp-head');
  head.setAttribute('data-component', 'SelectPanel.Header');
  const title = el('h2', 'ggt-sp-title', 'Select branches');
  title.setAttribute('data-component', 'SelectPanel.Title');
  head.appendChild(title);
  wrapper.appendChild(head);

  const fal = el('div', 'ggt-fal');
  fal.setAttribute('data-component', 'FilteredActionList');
  wrapper.appendChild(fal);

  const inputWrap = el('span', 'ggt-input');
  inputWrap.setAttribute('data-component', 'TextInput');
  inputWrap.setAttribute('data-contrast', 'true');
  const inputIcon = el('span', 'ggt-input-icon');
  inputIcon.setAttribute('data-component', 'TextInput.LeadingVisual');
  inputIcon.appendChild(octicon('search'));
  const filter = el('input');
  filter.type = 'text';
  filter.placeholder = 'Find a branch...';
  filter.setAttribute('data-component', 'input');
  filter.setAttribute('aria-label', 'Filter branches');
  filter.value = panelFilter;
  inputWrap.append(inputIcon, filter);
  const filterRow = el('div', 'ggt-fal-head');
  filterRow.setAttribute('data-component', 'FilteredActionList.Header');
  filterRow.appendChild(inputWrap);
  fal.appendChild(filterRow);

  const listBox = el('div', 'ggt-fal-body');
  const list = el('ul', 'ggt-list');
  list.setAttribute('data-component', 'ActionList');
  list.setAttribute('data-variant', 'inset');
  list.setAttribute('data-dividers', 'true');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  list.setAttribute('aria-label', 'Branches');
  listBox.appendChild(list);
  fal.appendChild(listBox);

  let activeRow = null; // the row the pointer or the keyboard is on
  let busy = false;
  async function apply(names, row) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    row?.classList.add('ggt-item-busy');
    await onSelectBranches(names);
    // The re-render replaces this control; nothing to restore here.
  }

  // One ActionList.Item: selection slot, leading visual, label, optional pill.
  function addRow({ label, on, tag, tagClass, tagTitle, disabled, onPick }) {
    const item = el('li', 'ggt-item');
    item.setAttribute('data-component', 'ActionList.Item');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(on));
    item.tabIndex = -1;
    const content = el('div', 'ggt-item-content');
    const selection = el('span', 'ggt-sel');
    selection.setAttribute('data-component', 'ActionList.Selection');
    selection.appendChild(octicon('check'));
    const visual = el('span', 'ggt-vis');
    visual.setAttribute('data-component', 'ActionList.LeadingVisual');
    visual.appendChild(octicon('git-branch'));
    const sub = el('span', 'ggt-sub');
    sub.setAttribute('data-component', 'ActionList.Item--DividerContainer');
    const name = el('span', 'ggt-label', label);
    name.setAttribute('data-component', 'ActionList.Item.Label');
    sub.appendChild(name);
    if (tag) {
      const pill = el('span', `ggt-row-pill${tagClass ? ' ' + tagClass : ''}`, tag);
      pill.setAttribute('data-component', 'Label');
      if (tagTitle) pill.title = tagTitle;
      sub.appendChild(pill);
    }
    content.append(selection, visual, sub);
    item.appendChild(content);
    if (disabled) item.setAttribute('aria-disabled', 'true');
    else {
      item.addEventListener('click', () => onPick(item));
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPick(item);
        }
      });
      // GitHub's SelectPanel marks the row under the pointer or the keyboard
      // as the active descendant; its CSS hangs the accent bar, the stronger
      // background and the divider suppression off that attribute.
      const activate = () => {
        activeRow?.removeAttribute('data-is-active-descendant');
        activeRow = item;
        item.setAttribute('data-is-active-descendant', 'activated-directly');
      };
      item.addEventListener('mouseenter', activate);
      item.addEventListener('focus', activate);
      item.addEventListener('mouseleave', () => {
        item.removeAttribute('data-is-active-descendant');
        if (activeRow === item) activeRow = null;
      });
    }
    list.appendChild(item);
    return item;
  }

  // The scope switch: the only two settings worth one click, in the header
  // where a control over the whole list belongs. A branch that cannot be
  // pulled in is not part of "All", or the segment could never look active.
  const names = branches.map((branch) => branch.name);
  const pickable = branches.filter((branch) => branch.loaded || canFetch).map((b) => b.name);
  const hasDefault = defaultBranch && names.includes(defaultBranch);
  if (hasDefault) {
    const isDefaultOnly = selected.size === 1 && selected.has(defaultBranch);
    const isAll = pickable.length > 0 && pickable.every((name) => selected.has(name));
    const seg = el('ul', 'ggt-seg');
    seg.setAttribute('data-component', 'SegmentedControl');
    seg.setAttribute('data-size', 'small');
    seg.setAttribute('aria-label', 'Branch scope');
    const segment = (label, active, names_, title_) => {
      const item = el('li', 'ggt-seg-item');
      item.setAttribute('data-component', 'SegmentedControl.Button');
      if (active) item.setAttribute('data-selected', '');
      const btn = el('button', 'ggt-seg-btn');
      btn.type = 'button';
      btn.title = title_;
      btn.setAttribute('aria-pressed', String(active));
      const content = el('span', 'ggt-seg-content');
      // data-text reserves the width the label would take, so switching
      // segments cannot shift the control — Primer's own trick.
      const text = el('div', 'ggt-seg-text', label);
      text.setAttribute('data-text', label);
      content.appendChild(text);
      btn.appendChild(content);
      // Re-applying the setting already in force would only cost a fetch.
      if (!active) btn.addEventListener('click', () => apply(names_, null));
      item.appendChild(btn);
      seg.appendChild(item);
    };
    segment('Default', isDefaultOnly, [defaultBranch], `Draw only ${defaultBranch}`);
    segment('All', isAll, pickable, 'Draw every branch');
    head.appendChild(seg);
  }

  const rows = [];
  const ordered = [...branches].sort((a, b) => {
    const rank = (branch) =>
      (branch.name === defaultBranch ? 0 : 2) - (selected.has(branch.name) ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  // One decision per row rather than four ternaries over the same state: a
  // branch is loaded, or it can be pulled in, or nothing can reach it —
  // and separately it may be the default. Nothing can pull an unloaded
  // branch in without a live ref source (offline, or an endpoint changed).
  const KINDS = {
    loaded: {},
    fetch: {
      tag: 'fetch',
      tagClass: 'ggt-row-pill-fetch',
      tagTitle: 'Outside the loaded window — picking this pulls the branch in.',
    },
    unavailable: {
      tag: 'unavailable',
      tagClass: 'ggt-row-pill-fetch',
      tagTitle: 'Outside the loaded window, and no live ref source answered to pull it in.',
      disabled: true,
    },
  };
  for (const branch of ordered) {
    const kind = KINDS[branch.loaded ? 'loaded' : canFetch ? 'fetch' : 'unavailable'];
    const isDefault = branch.name === defaultBranch;
    const on = selected.has(branch.name);
    const only = on && selected.size === 1;
    const item = addRow({
      ...kind,
      label: branch.name,
      on,
      // The default branch says so instead of its state; its tooltip still
      // explains the state when there is one to explain.
      ...(isDefault ? { tag: 'default', tagClass: '' } : {}),
      onPick: (row) => {
        // The default branch is always drawn, in the leftmost lane; and a
        // graph of no branches is not a state worth reaching by accident.
        if (isDefault || only) return;
        const next = on
          ? [...selected].filter((name) => name !== branch.name)
          : [...selected, branch.name];
        apply(next, row);
      },
    });
    if (isDefault) item.title = 'The default branch is always drawn, in the leftmost lane.';
    else if (only) item.title = 'At least one branch has to be shown.';
    rows.push({ name: branch.name, item });
  }

  const empty = el('div', 'ggt-list-empty', 'No branches match.');
  empty.hidden = true;
  listBox.appendChild(empty);

  function runFilter() {
    panelFilter = filter.value;
    const needle = panelFilter.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const hit = !needle || row.name.toLowerCase().includes(needle);
      row.item.hidden = !hit;
      if (hit) shown++;
    }
    empty.hidden = shown > 0;
  }
  filter.addEventListener('input', runFilter);

  // Anchored to the button, clamped to the viewport, kept in place while the
  // page scrolls under it. Set inline as well as in the injected stylesheet:
  // nothing about where the menu lands may depend on a stylesheet's timing.
  function place() {
    const box = button.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.right - PANEL_WIDTH, innerWidth - PANEL_WIDTH - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${box.bottom + 4}px`;
    panel.style.maxHeight = `${Math.max(180, innerHeight - box.bottom - 24)}px`;
  }

  // Scroll fires from every scroller on a GitHub page; measuring the anchor
  // forces layout, so the work is coalesced into one frame and the listener
  // stays passive.
  let placeQueued = false;
  const placeSoon = () => {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  };
  const onDocClick = (event) => {
    if (!panel.contains(event.target) && !button.contains(event.target)) close();
  };
  // Escape is watched on the document, not on the panel: picking a row
  // applies straight away and focus is usually back on the page by then.
  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
      button.focus();
    }
  };
  const detach = () => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', placeSoon, true);
    removeEventListener('resize', placeSoon);
  };
  function close() {
    panel.hidden = true;
    panelOpen = false;
    button.setAttribute('aria-expanded', 'false');
    detach();
    detachPanel = null;
  }
  function open(focusFilter) {
    panel.hidden = false;
    panelOpen = true;
    button.setAttribute('aria-expanded', 'true');
    place();
    // When a pick re-renders the view, this runs before the new toolbar is
    // in the document and the button's rect is all zeros; measure again once
    // it has been attached, or the menu lands in the top-left corner.
    requestAnimationFrame(place);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    addEventListener('scroll', placeSoon, { capture: true, passive: true });
    addEventListener('resize', placeSoon);
    detachPanel = detach;
    if (focusFilter) filter.focus();
  }
  button.addEventListener('click', () => (panel.hidden ? open(true) : close()));

  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const visible = [...list.querySelectorAll('li[role="option"]')].filter((item) => !item.hidden);
    if (visible.length === 0) return;
    const at = visible.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    visible[(at + step + visible.length) % visible.length].focus();
  });

  document.body.appendChild(panel);
  runFilter();
  // Applying re-renders the view; reopen so the menu does not blink shut
  // under the pointer after every pick.
  if (panelOpen) open(false);

  return button;
}

function avatarFallback(commit) {
  const initial = (commit.login || commit.author || '?').charAt(0).toUpperCase();
  const span = el('span', 'ggt-avatar ggt-avatar-fallback', initial);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * Render the graph view into `container` (cleared first).
 * model: { owner, repo, commits, graph, heads, tags, fresh, filtered, total,
 *   updating, loaded, olderCount, failedWindows, hasMore, onLoadOlder, onRefresh,
 *   branches, selected, defaultBranch, truncated, canFetch, onSelectBranches }
 */
export function render(container, model) {
  ensureUiStyle();
  const {
    owner, repo, commits, graph, heads, tags, fresh, updating = false, filtered, hasMore,
    total, loaded, olderCount, failedWindows, onLoadOlder, onRefresh,
    branches, truncated = [],
  } = model;

  const refsByOid = new Map();
  for (const head of heads) {
    if (!refsByOid.has(head.oid)) refsByOid.set(head.oid, []);
    refsByOid.get(head.oid).push(head.name);
  }
  const headOids = new Set(refsByOid.keys());
  const tagsByOid = new Map();
  for (const tag of tags) {
    if (!tagsByOid.has(tag.oid)) tagsByOid.set(tag.oid, []);
    tagsByOid.get(tag.oid).push(tag.name);
  }

  const root = el('div', 'ggt-root');
  const grandTotal = Math.max(total, loaded);
  const { shell, toolbar } = buildShell(
    `${owner}/${repo} · ${loaded} of ${grandTotal} commits loaded · ` +
      `${heads.length} of ${branches.length} ` +
      `${branches.length === 1 ? 'branch' : 'branches'} shown` +
      (tags.length > 0 ? ` · ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}` : ''),
  );

  const actions = el('div', 'ggt-actions');
  if (branches.length > 0) actions.appendChild(buildBranchPicker(model));
  // Status only: the graph always tops the snapshot up with live heads.
  const pill = el('span', 'ggt-pill' + (fresh && !updating ? ' ggt-pill-fresh' : ''),
    updating ? 'Updating…' : fresh ? 'Fresh' : 'Cached');
  pill.title = updating
    ? "Showing GitHub's cached snapshot while newer commits are fetched; the graph updates when they arrive."
    : fresh
      ? 'Branch heads were verified live; the graph is current.'
      : "Freshness could not be verified — GitHub's cached snapshot may lag recent pushes. " +
        'Use Refresh to try again.';
  actions.appendChild(pill);
  const refresh = el('button', 'ggt-btn', 'Refresh');
  refresh.title = 'Reload the graph from GitHub';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    onRefresh();
  });
  actions.appendChild(refresh);
  toolbar.appendChild(actions);

  const repoKey = `${owner}/${repo}`;
  const banners = [];
  if (!filtered) {
    banners.push(banner(repoKey,
      'No branch head of this repository is inside the loaded window — showing the raw fork network.'));
  }
  if (truncated.length > 0) {
    banners.push(banner(repoKey,
      `Only the newest commits of ${truncated.join(', ')} were loaded — ` +
        'the dashed line marks where history continues; "Load older commits" fetches more.'));
  }
  if (failedWindows > 0) {
    banners.push(banner(repoKey,
      `Skipped ${failedWindows} older window${failedWindows === 1 ? '' : 's'} ` +
        'that GitHub could not return — the graph may have gaps.', true));
  }
  for (const node of banners) if (node) shell.appendChild(node);

  const { svg, width } = buildSvg(graph, headOids, commits);
  const divider = initColumns(root, { graph: width + 20, author: 150, date: 88, sha: 64 });

  const cols = el('div', 'ggt-head');
  cols.appendChild(el('span', 'ggt-h-graph', 'Graph'));
  cols.appendChild(el('span', 'ggt-h-desc', 'Description'));
  cols.appendChild(el('span', 'ggt-author', 'Author'));
  cols.appendChild(el('span', 'ggt-date', 'Date'));
  cols.appendChild(el('span', 'ggt-sha', 'Commit'));
  cols.appendChild(divider('graph', +1));
  cols.appendChild(divider('author', -1));
  cols.appendChild(divider('date', -1));
  cols.appendChild(divider('sha', -1));
  shell.appendChild(cols);

  const rows = el('div', 'ggt-rows');

  commits.forEach((commit, i) => {
    const row = el('div', 'ggt-row');

    const refs = refsByOid.get(commit.oid);
    const tagNames = tagsByOid.get(commit.oid);
    if (refs || tagNames) {
      const refsBox = el('span', 'ggt-refs');
      // /tree/ serves both branches and tags; encode per segment so names
      // with slashes stay path-shaped, as GitHub's own links do.
      const treeHref = (name) =>
        `/${owner}/${repo}/tree/${name.split('/').map(encodeURIComponent).join('/')}`;
      for (const name of refs || []) {
        const chip = el('a', 'ggt-ref', name);
        chip.href = treeHref(name);
        chip.style.color = colorOf(graph.nodes[i].color);
        chip.style.borderColor = 'currentColor';
        refsBox.appendChild(chip);
      }
      for (const name of tagNames || []) {
        const chip = el('a', 'ggt-ref ggt-tag', name);
        chip.href = treeHref(name);
        chip.title = `tag: ${name}`;
        chip.style.color = colorOf(graph.nodes[i].color);
        chip.style.borderColor = 'currentColor';
        refsBox.appendChild(chip);
      }
      row.appendChild(refsBox);
    }

    const msg = el('a', 'ggt-msg', commit.subject || commit.oid.slice(0, 7));
    msg.href = `/${owner}/${repo}/commit/${commit.oid}`;
    if (commit.message !== commit.subject || commit.author) {
      msg.title = commit.message + (commit.author ? `\n\n${commit.author}` : '');
    }
    row.appendChild(msg);

    const author = el(commit.login ? 'a' : 'span', 'ggt-author');
    if (commit.login) author.href = `/${encodeURIComponent(commit.login)}`;
    if (commit.avatar) {
      const img = el('img', 'ggt-avatar');
      img.src = commit.avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.replaceWith(avatarFallback(commit)));
      author.appendChild(img);
    } else {
      author.appendChild(avatarFallback(commit));
    }
    author.appendChild(document.createTextNode(commit.login || commit.author));
    row.appendChild(author);

    const time = el('time', 'ggt-date', commit.date ? relTime(commit.date) : '—');
    time.title = commit.date ? commit.date.toLocaleString() : 'Date unavailable';
    row.appendChild(time);

    const sha = el('a', 'ggt-sha', commit.oid.slice(0, 7));
    sha.href = `/${owner}/${repo}/commit/${commit.oid}`;
    row.appendChild(sha);

    rows.appendChild(row);
  });

  const wrap = el('div', 'ggt-wrap');
  wrap.appendChild(rows);
  wrap.appendChild(svg);
  shell.appendChild(wrap);

  if (hasMore) {
    const footer = el('div', 'ggt-footer');
    const more = el('button', 'ggt-btn', `Load ${olderCount} older commit${olderCount === 1 ? '' : 's'}`);
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      more.setAttribute('aria-busy', 'true');
      await onLoadOlder();
    });
    footer.appendChild(more);
    footer.appendChild(el('span', 'ggt-footer-count', `${loaded} of ${grandTotal} loaded`));
    footer.setAttribute('aria-live', 'polite');
    shell.appendChild(footer);
  }

  root.appendChild(shell);
  // One swap, then a short fade: the row count and the frame's height change
  // with every pick, and a hard cut through that reads as a flash.
  root.classList.add('ggt-fade-in');
  const scrollY = window.scrollY;
  container.textContent = '';
  container.appendChild(root);
  if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY });
}

/**
 * Centered status message inside the framed shell, in place of the graph.
 * options: { error, busy, detail, onRetry }. busy adds an indeterminate
 * progress bar (how long GitHub takes to produce the snapshot is unknown);
 * onRetry adds a "Try again" button.
 */
export function renderStatus(container, repoRef, text, options = {}) {
  const { error = false, busy = false, detail = '', onRetry = null } = options;
  container.textContent = '';
  const root = el('div', 'ggt-root');
  const { shell } = buildShell(repoRef ? `${repoRef.owner}/${repoRef.repo}` : '');
  if (busy) shell.setAttribute('aria-busy', 'true');

  const status = el('div', 'ggt-status' + (error ? ' ggt-error' : ''));
  if (error) status.setAttribute('role', 'alert');
  status.appendChild(el('div', null, text));
  if (detail) status.appendChild(el('div', 'ggt-status-detail', detail));
  if (busy) {
    const track = el('div', 'ggt-progress');
    track.appendChild(el('div', 'ggt-progress-fill'));
    status.appendChild(track);
  }
  if (onRetry) {
    const retry = el('button', 'ggt-btn ggt-retry', 'Try again');
    retry.addEventListener('click', onRetry);
    status.appendChild(retry);
  }
  shell.appendChild(status);
  root.appendChild(shell);
  container.appendChild(root);
}
