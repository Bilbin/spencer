import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '../../../protocol/src/identity.ts';
import { pairKey } from '../../../protocol/src/channel.ts';
import { randomId } from '../../../protocol/src/encoding.ts';
import { LinkManager } from '../../src/p2p/links.ts';

test('loopback links authenticate and open file channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-')); const a = generateIdentity(), b = generateIdentity(); let received = 0;
  let left: LinkManager, right: LinkManager;
  const make = (me: typeof a, dest: () => LinkManager) => new LinkManager({ dataDir: join(dir, me.id), me, sendSignal: (ch, body) => { void dest().onSignal(ch, me.id, body); }, pairKey: (ch, peer) => pairKey(me.secret, peer, me.id, ch), authorize: () => ({ ok: true, allowLocalAddresses: true, stunServers: [] }), onFileChannel: () => { received++; }, ownerNote: () => {}, log: console.error, tuning: { allowLoopback: true, cleanupOnStop: false, idleTimeoutMs: 100 } });
  left = make(a, () => right); right = make(b, () => left); left.start(); right.start();
  try { for (const ch of [randomId(), randomId()]) { const link = await left.ensureLink(ch, b.id); assert.ok(link); await new Promise(r => setTimeout(r, 50)); assert.ok(right.getLink(ch, a.id)); const dc = left.openFileChannel(ch, b.id, `f:${randomId()}:1`); assert.ok(dc); await new Promise(r => setTimeout(r, 100)); assert.ok(received); dc.close(); left.closeChannel(ch); right.closeChannel(ch); } } finally { left.stop(); right.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('crash marker disables the channel', () => { const dir = mkdtempSync(join(tmpdir(), 'links-')); const ch = randomId(); writeFileSync(join(dir, 'p2p-attempt'), JSON.stringify({ ch, ts: 1 })); let notes = 0; const m = new LinkManager({ dataDir: dir, me: generateIdentity(), sendSignal() {}, pairKey: () => new Uint8Array(32), authorize: () => ({ ok: true, allowLocalAddresses: false, stunServers: [] }), onFileChannel() {}, ownerNote: () => { notes++; }, log() {}, tuning: { cleanupOnStop: false } }); try { m.start(); assert.equal(m.isCrashDisabled(ch), true); assert.equal(notes, 1); } finally { m.stop(); rmSync(dir, { recursive: true, force: true }); } });

test('crash disable survives restart and expires after 24 hours', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const ch = randomId();
  let now = 1_000;
  let notes = 0;
  writeFileSync(join(dir, 'p2p-attempt'), JSON.stringify({ ch, ts: now }));
  const make = () => new LinkManager({ dataDir: dir, me: generateIdentity(), sendSignal() {}, pairKey: () => new Uint8Array(32), authorize: () => ({ ok: true, allowLocalAddresses: false, stunServers: [] }), onFileChannel() {}, ownerNote: () => { notes++; }, log() {}, now: () => now, tuning: { cleanupOnStop: false } });
  const first = make();
  const second = make();
  try {
    first.start();
    assert.equal(JSON.parse(readFileSync(join(dir, 'p2p-disabled.json'), 'utf8'))[ch], now + 86_400_000);
    first.stop();
    second.start();
    assert.equal(second.isCrashDisabled(ch), true);
    assert.equal(notes, 1);
    now += 86_400_000;
    assert.equal(second.isCrashDisabled(ch), false);
  } finally {
    first.stop(); second.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
