import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadP2pAddon } from "../../src/p2p/addon.ts";

test("loads the installed addon and an unpacked copy, and reports missing files", () => {
  const installed = loadP2pAddon();
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  const dir = mkdtempSync(join(tmpdir(), "spencer-addon-"));
  try {
    const copy = join(dir, "addon.node");
    copyFileSync(installed.path, copy);
    assert.equal(loadP2pAddon(copy).ok, true);
    const missing = loadP2pAddon(join(dir, "missing.node"));
    assert.equal(missing.ok, false);
    const corrupt = join(dir, "corrupt.node");
    writeFileSync(corrupt, Buffer.from("not a native addon"));
    const bad = loadP2pAddon(corrupt);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native loopback transfers data and exits after cleanup', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `
    const rtc = require('node-datachannel');
    const a = new rtc.PeerConnection('a', {iceServers: [], disableAutoNegotiation: true, maxMessageSize: 262144});
    const b = new rtc.PeerConnection('b', {iceServers: [], disableAutoNegotiation: true, maxMessageSize: 262144});
    const dc = a.createDataChannel('test'); let remote;
    if (a.remoteFingerprint()?.value || b.remoteFingerprint()?.value) throw Error('early fingerprint');
    a.onLocalDescription((s,t) => { b.setRemoteDescription(s,t); b.setLocalDescription("answer"); });
    b.onLocalDescription((s,t) => a.setRemoteDescription(s,t));
    a.onLocalCandidate((c,m) => b.addRemoteCandidate(c,m));
    b.onLocalCandidate((c,m) => a.addRemoteCandidate(c,m));
    b.onDataChannel(c => { remote = c; c.onMessage(m => { if (m.length !== 65536) throw Error('bad data'); setTimeout(() => { c.close(); dc.close(); a.close(); b.close(); setTimeout(() => { rtc.cleanup(); const again = new rtc.PeerConnection('again', {iceServers: []}); again.close(); rtc.cleanup(); }, 100); }, 10); }); });
    a.setLocalDescription('offer');
    dc.onOpen(() => { const fp = a.remoteFingerprint(); if (fp.algorithm !== 'sha-256' || !fp.value) throw Error('bad fingerprint'); dc.sendMessageBinary(Buffer.alloc(65536)); let failed = false; try { failed = !dc.sendMessageBinary(Buffer.alloc(262145)); } catch { failed = true; } if (!failed) throw Error('oversize accepted'); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 8000, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`);
});
