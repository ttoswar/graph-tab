import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { parsePack, lsRefs } from '../src/gitproto.js';

function oidOf(content) {
  return createHash('sha1')
    .update(`commit ${content.length}\0`)
    .update(content)
    .digest('hex');
}

function commitBytes({ parents = [], author = 'A D <a@d> 1783425707 +0200', message }) {
  return Buffer.from(
    'tree 5d6ce700f8d74e8de7dfaf0d89a35f75b94d1483\n' +
      parents.map((p) => `parent ${p}\n`).join('') +
      `author ${author}\ncommitter ${author}\n\n${message}`
  );
}

// varint object header used inside packs (type in bits 4-6 of the first byte)
function objHeader(type, size) {
  const bytes = [(type << 4) | (size & 15)];
  size >>= 4;
  while (size > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(size & 127);
    size >>= 7;
  }
  return Buffer.from(bytes);
}

function varint(n) {
  const bytes = [];
  do {
    bytes.push((n & 127) | (n > 127 ? 128 : 0));
    n >>= 7;
  } while (n > 0);
  return Buffer.from(bytes);
}

function deltaOf(base, target) {
  // srcSize varint, outSize varint, one copy op, then insert ops (<=127 bytes each)
  const common = Math.min(20, base.length, target.length);
  const inserts = [];
  for (let i = common; i < target.length; i += 127) {
    const chunk = target.subarray(i, i + 127);
    inserts.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat([
    varint(base.length),
    varint(target.length),
    Buffer.from([0x80 | 0x10, common]), // copy from offset 0, explicit size byte
    ...inserts,
  ]);
}

test('parsePack: plain, ref-delta, and ofs-delta commits', async () => {
  const root = commitBytes({ message: 'root\n' });
  const rootOid = oidOf(root);
  const child = commitBytes({ parents: [rootOid], message: 'child\n' });
  const childOid = oidOf(child);
  const grand = commitBytes({ parents: [childOid], message: 'grandchild\n' });

  const parts = [Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3])])];
  let offset = 12;
  const push = (...bufs) => {
    for (const b of bufs) parts.push(b);
    const at = offset;
    offset += bufs.reduce((n, b) => n + b.length, 0);
    return at;
  };

  const rootOffset = push(objHeader(1, root.length), zlib.deflateSync(root));
  // child as ref-delta on root
  const refDelta = deltaOf(root, child);
  push(objHeader(7, refDelta.length), Buffer.from(rootOid, 'hex'), zlib.deflateSync(refDelta));
  // grandchild as ofs-delta on root (git's biased big-endian offset varint)
  const ofsVarint = (n) => {
    const bytes = [n & 127];
    while ((n >>= 7)) bytes.unshift(128 | (--n & 127));
    return Buffer.from(bytes);
  };
  const ofsDelta = deltaOf(root, grand);
  const ofsAt = push(objHeader(6, ofsDelta.length));
  push(ofsVarint(ofsAt - rootOffset), zlib.deflateSync(ofsDelta));
  push(Buffer.alloc(20)); // trailer checksum (unread)

  const commits = await parsePack(new Uint8Array(Buffer.concat(parts)));
  assert.equal(commits.length, 3);
  const byMsg = Object.fromEntries(commits.map((c) => [c.message.trim(), c]));
  assert.equal(byMsg.root.oid, rootOid);
  assert.deepEqual(byMsg.child.parents, [rootOid]);
  assert.equal(byMsg.child.oid, childOid);
  assert.deepEqual(byMsg.grandchild.parents, [childOid]);
  assert.equal(byMsg.root.author, 'A D');
  assert.equal(byMsg.root.email, 'a@d');
  assert.equal(byMsg.root.date.getTime(), 1783425707000);
});

test('lsRefs parses pkt-line ref advertisement', async () => {
  const pkt = (s) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
  const body =
    pkt('df7f2341aedd9e596c3709b41b0a25606f4e2298 HEAD symref-target:refs/heads/main\n') +
    pkt('df7f2341aedd9e596c3709b41b0a25606f4e2298 refs/heads/main\n') +
    pkt('fdbe98a9262f0545c8cbbfdbfa08a5a49bcacf08 refs/heads/feat/a b\n') + // symref hint after space is ignored
    pkt(`${'1'.repeat(40)} refs/tags/v1.0.0 peeled:${'2'.repeat(40)}\n`) + // annotated: peeled commit wins
    pkt(`${'3'.repeat(40)} refs/tags/light\n`) + // lightweight: its own oid is the commit
    '0000';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/o/r.git/git-upload-pack');
    assert.match(init.body, /command=ls-refs/);
    assert.match(init.body, /peel\n/);
    assert.match(init.body, /ref-prefix refs\/tags\//);
    assert.match(init.body, /symrefs\n/);
    return new Response(Buffer.from(body));
  };
  try {
    const { heads, tags, head } = await lsRefs('o', 'r');
    // HEAD's symref target is the default branch, and never a branch itself
    assert.equal(head, 'main');
    assert.deepEqual(heads, [
      { name: 'main', oid: 'df7f2341aedd9e596c3709b41b0a25606f4e2298' },
      { name: 'feat/a', oid: 'fdbe98a9262f0545c8cbbfdbfa08a5a49bcacf08' },
    ]);
    assert.deepEqual(tags, [
      { name: 'v1.0.0', oid: '2'.repeat(40) },
      { name: 'light', oid: '3'.repeat(40) },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
