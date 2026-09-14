// Octicons, GitHub's own icon set, inlined.
//
// The extension cannot load GitHub's sprite, and copying an icon out of the
// live page (the trick tab.js uses for nav classes) is not an option for
// icons the current page may not contain. So the handful of paths the graph
// view needs are kept here, verbatim from primer/octicons at 16px, with the
// same presentation attributes GitHub's own <svg> carries — that is what
// makes them line up with the icons already on the page.

const PATHS = {
  'git-branch':
    'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 ' +
    '2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 ' +
    '1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a' +
    '.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  'triangle-down':
    'm4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a' +
    '.25.25 0 0 0-.177.427Z',
  check:
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 ' +
    '.018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  x:
    'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 ' +
    '8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018' +
    '.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
  search:
    'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 ' +
    '1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// One prototype per icon, cloned per use: the picker asks for two icons per
// branch row and rebuilds on every render, and cloning beats replaying a
// dozen setAttribute calls each time.
const prototypes = new Map();

/** A 16px Octicon <svg>, presented the way GitHub presents its own. */
export function octicon(name) {
  let proto = prototypes.get(name);
  if (!proto) {
    proto = document.createElementNS(SVG_NS, 'svg');
    proto.setAttribute('viewBox', '0 0 16 16');
    proto.setAttribute('width', '16');
    proto.setAttribute('height', '16');
    proto.setAttribute('aria-hidden', 'true');
    proto.setAttribute('focusable', 'false');
    proto.setAttribute('data-component', 'Octicon');
    proto.setAttribute('fill', 'currentColor');
    proto.setAttribute('display', 'inline-block');
    proto.setAttribute('overflow', 'visible');
    proto.setAttribute('style', 'vertical-align:text-bottom');
    proto.setAttribute('class', `octicon octicon-${name}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', PATHS[name]);
    proto.appendChild(path);
    prototypes.set(name, proto);
  }
  return proto.cloneNode(true);
}
