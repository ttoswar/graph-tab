import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/tab.js', import.meta.url), 'utf8');
// The icon's presentation attributes live in octicon.js, which builds every
// Octicon in the extension; tab.js only asks for one and lets GitHub's own
// sibling classes land on top.
const octicon = await readFile(new URL('../src/octicon.js', import.meta.url), 'utf8');

test('Graph tab uses Primer icon and text component slots', () => {
  assert.match(source, /iconSlot\.setAttribute\('data-component', 'icon'\)/);
  assert.match(source, /label\.setAttribute\('data-component', 'text'\)/);
  assert.match(source, /const icon = octicon\('git-branch'\)/);
  assert.match(source, /copyClasses\(siblingLink\?\.querySelector\('svg'\), icon\)/);
  assert.match(source, /link\.appendChild\(iconSlot\);\s+link\.appendChild\(label\);/);
});

test('Graph icon keeps the native Octicon presentation attributes', () => {
  assert.match(octicon, /setAttribute\('data-component', 'Octicon'\)/);
  assert.match(octicon, /setAttribute\('fill', 'currentColor'\)/);
  assert.match(octicon, /setAttribute\('focusable', 'false'\)/);
  assert.match(octicon, /setAttribute\('style', 'vertical-align:text-bottom'\)/);
});
