// Fresh commit data over git's smart-HTTP protocol v2. github.com/{o}/{r}.git
// is same-origin with github.com, so a content script can speak real git:
// ls-refs returns exact branch heads (the network-graph snapshot lags pushes
// by minutes to hours), and a tree:0-filtered fetch with have-negotiation
// returns a tiny pack holding only the commits the snapshot is missing.
// Anonymous access covers public repos; private repos answer 401 (git auth
// is Basic/token, not the web session) and callers treat any throw here as
// "no top-up available".

import { zlibInflate } from './inflate.js';

const decoder = new TextDecoder();

function pktLine(text) {
  return (text.length + 4).toString(16).padStart(4, '0') + text;
}

function* pktLines(buf) {
  for (let i = 0; i < buf.length; ) {
    const size = parseInt(decoder.decode(buf.subarray(i, i + 4)), 16);
    if (!(size >= 4)) {
      i += 4; // flush-pkt / delim-pkt (or garbage, which ends parsing below)
      if (Number.isNaN(size)) return;
      continue;
    }
    yield buf.subarray(i + 4, i + size);
    i += size;
  }
}

async function uploadPack(owner, repo, lines) {
  const url = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-upload-pack`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-git-upload-pack-request',
      'Git-Protocol': 'version=2',
    },
    body: lines.join(''),
    // No cookies: we emulate an anonymous git client, and a credentialed 401
    // would make the browser pop its Basic-auth dialog over the page.
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`git-upload-pack: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Exact branch heads, tags and the default branch, straight from the git
 * server: { heads: [{ name, oid }], tags: [{ name, oid }], head }.
 * `peel` makes the server append "peeled:<oid>" to annotated-tag lines, so
 * every tag oid here is the commit it points at, never the tag object;
 * `symrefs` makes it append "symref-target:refs/heads/<name>" to HEAD, which
 * is the repository's default branch (the one the graph always draws).
 */
export async function lsRefs(owner, repo) {
  const data = await uploadPack(owner, repo, [
    pktLine('command=ls-refs\n'), '0001', pktLine('peel\n'), pktLine('symrefs\n'),
    pktLine('ref-prefix HEAD\n'),
    pktLine('ref-prefix refs/heads/\n'), pktLine('ref-prefix refs/tags/\n'), '0000',
  ]);
  const heads = [];
  const tags = [];
  let head = '';
  for (const line of pktLines(data)) {
    const [oid, name, ...attrs] = decoder.decode(line).trim().split(' ');
    if (!name || !/^[0-9a-f]{40}$/.test(oid)) continue;
    if (name === 'HEAD') {
      const target = attrs.find((attr) => attr.startsWith('symref-target:'))?.slice('symref-target:'.length);
      if (target && target.startsWith('refs/heads/')) head = target.slice('refs/heads/'.length);
    } else if (name.startsWith('refs/heads/')) {
      heads.push({ name: name.slice('refs/heads/'.length), oid });
    } else if (name.startsWith('refs/tags/')) {
      const peeled = attrs.find((attr) => attr.startsWith('peeled:'))?.slice('peeled:'.length);
      const target = peeled && /^[0-9a-f]{40}$/.test(peeled) ? peeled : oid;
      tags.push({ name: name.slice('refs/tags/'.length), oid: target });
    }
  }
  return { heads, tags, head };
}

/**
 * Fetch the commits at the tip of `wants`, as parsed commit objects:
 * [{ oid, parents, author, date, message }]. `depth` bounds the walk from
 * each want, so this cannot pull a whole history.
 *
 * `haves` is optional and must be used with care: "have X" promises the
 * server that X *and all of its ancestors* are present, and the loaded set
 * here is a window into GitHub's network array, not an ancestor-closed set.
 * It is right for one job only — a branch whose snapshot head is loaded and
 * whose live head moved past it: `have <snapshot head>` stops the pack
 * exactly where known history begins, so the new commits are bridged
 * however many there are (up to `depth`), and nothing older is fetched.
 * Passing every snapshot head (what this used to do) included the very oids
 * being asked for, made the server negotiate everything away, and no branch
 * outside the window was ever pulled in; such wants go without haves and
 * with a small depth. `filter tree:0` keeps the cost to commit objects only,
 * a few hundred bytes each.
 *
 * `deepen` counts depth along *every* parent of a merge, so it grows fast on
 * merge-heavy histories (git/git: 239 objects at 8, 3199 at 25). Callers keep
 * it small and cut the result down themselves, unless haves bound it.
 */
export async function fetchMissingCommits(owner, repo, wants, depth, haves = []) {
  const lines = [pktLine('command=fetch\n'), '0001',
    pktLine('filter tree:0\n'), pktLine('no-progress\n'), pktLine(`deepen ${depth}\n`)];
  for (const oid of wants) lines.push(pktLine(`want ${oid}\n`));
  for (const oid of haves) lines.push(pktLine(`have ${oid}\n`));
  lines.push(pktLine('done\n'), '0000');
  const data = await uploadPack(owner, repo, lines);

  // Sections arrive as pkt-lines; after the "packfile" marker each line is
  // side-band framed (1 = pack data, 2 = progress, 3 = fatal error).
  let inPack = false;
  const parts = [];
  for (const line of pktLines(data)) {
    if (!inPack) {
      inPack = decoder.decode(line) === 'packfile\n';
      continue;
    }
    if (line[0] === 1) parts.push(line.subarray(1));
    else if (line[0] === 3) throw new Error('git fetch: ' + decoder.decode(line.subarray(1)));
  }
  const pack = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => (pack.set(p, offset), offset + p.length), 0);
  return parsePack(pack);
}

async function sha1hex(...chunks) {
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((offset, c) => (buf.set(c, offset), offset + c.length), 0);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Delta application (git's copy/insert format, used by ofs- and ref-delta).
function applyDelta(delta, base) {
  let pos = 0;
  const varint = () => {
    let value = 0, shift = 0, byte;
    do {
      byte = delta[pos++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const srcSize = varint(), outSize = varint();
  if (srcSize !== base.length) throw new Error('pack: delta base size mismatch');
  const out = new Uint8Array(outSize);
  let o = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(offset, offset + size), o);
      o += size;
    } else if (op) {
      out.set(delta.subarray(pos, pos + op), o);
      o += op;
      pos += op;
    } else {
      throw new Error('pack: invalid delta opcode');
    }
  }
  return out;
}

const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a pack (v2), resolving deltas; returns the commits it contains. */
export async function parsePack(pack) {
  if (decoder.decode(pack.subarray(0, 4)) !== 'PACK') throw new Error('pack: bad magic');
  const count = (pack[8] << 24 | pack[9] << 16 | pack[10] << 8 | pack[11]) >>> 0;

  const byOffset = new Map();
  const byOid = new Map();
  const commits = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const objStart = pos;
    let byte = pack[pos++];
    let type = (byte >> 4) & 7;
    let size = byte & 15, shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }

    let base = null;
    if (type === 6) { // ofs-delta: negative offset varint
      byte = pack[pos++];
      let back = byte & 127;
      while (byte & 0x80) {
        byte = pack[pos++];
        back = (back + 1) * 128 + (byte & 127);
      }
      base = byOffset.get(objStart - back);
    } else if (type === 7) { // ref-delta: 20-byte base oid
      const oid = [...pack.subarray(pos, pos + 20)]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      pos += 20;
      base = byOid.get(oid);
    }

    const { data, consumed } = zlibInflate(pack, pos, size);
    pos += consumed;

    let content = data;
    if (type === 6 || type === 7) {
      if (!base) throw new Error('pack: delta base not in pack');
      content = applyDelta(data, base.content);
      type = base.type;
    }

    const record = { type, content };
    byOffset.set(objStart, record);
    const oid = await sha1hex(
      new TextEncoder().encode(`${TYPE_NAMES[type]} ${content.length}\0`), content);
    byOid.set(oid, record);
    if (type === 1) commits.push(parseCommit(oid, content));
  }
  return commits;
}

function parseCommit(oid, bytes) {
  const text = decoder.decode(bytes);
  const headerEnd = text.indexOf('\n\n');
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const parents = [];
  let author = '', email = '', date = new Date();
  for (const line of text.slice(0, headerEnd < 0 ? text.length : headerEnd).split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) {
      const match = /^author (.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
      if (match) {
        author = match[1];
        email = match[2];
        date = new Date(Number(match[3]) * 1000);
      }
    }
  }
  return { oid, parents, author, email, date, message };
}
