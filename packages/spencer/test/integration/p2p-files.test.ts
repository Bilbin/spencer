import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay } from '../../../relay/src/index.ts';
import { Daemon } from '../../src/daemon.ts';
import { DEFAULT_POLICY } from '../../src/config.ts';
import { Api, tempDir, waitFor } from './harness.ts';

 test('direct file over a chat-only relay', { timeout: 60000 }, async () => {
  const tmp = tempDir('spencer-p2p-');
  const relay = await startRelay({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'relay.db'), stunBind: '127.0.0.1:0' });
  const nodes = ['Alice', 'Bob'].map(name => new Daemon({ dataDir: join(tmp.dir, name), config: { name, relay: relay.url, http: { host: '127.0.0.1', port: 0 }, model: { provider: 'fake' }, policy: { ...DEFAULT_POLICY, autoAcceptIncomingFiles: true } }, tuning: { p2p: { allowLoopback: true, cleanupOnStop: false } }, webRoot: null }));
  try {
    await Promise.all(nodes.map(n => n.start()));
    const [a, b] = nodes as [Daemon, Daemon];
    const inv = await a.createInvite('direct', 'Bob');
    await b.acceptInvite(inv.link);
    await waitFor(() => a.channels.peerHasFeature(inv.channel.id, b.identity.id, 'p2p-files/1') && b.channels.peerHasFeature(inv.channel.id, a.identity.id, 'p2p-files/1'), 'feature hello');
    const aa = new Api(a.port, a.token), bb = new Api(b.port, b.token);
    const data = randomBytes(64 * 1024), path = join(tmp.dir, 'file.bin');
    writeFileSync(path, data);
    const tr = await aa.sendFile(inv.channel.id, path);
    await aa.transferAction(tr.tid, 'approve');
    await waitFor(async () => (await aa.transfer(tr.tid)).state === 'completed' && (await bb.transfer(tr.tid)).state === 'completed', 'transfer', 30000);
    const sent = await aa.transfer(tr.tid), received = await bb.transfer(tr.tid);
    assert.equal(sent.via, 'link'); assert.equal(received.via, 'link');
    assert.equal(createHash('sha256').update(readFileSync(received.path!)).digest('hex'), createHash('sha256').update(data).digest('hex'));
  } finally { await Promise.all(nodes.map(n => n.stop())); await relay.close(); tmp.cleanup(); }
});

 test('group transfer reaches only the selected peer', { timeout: 60000 }, async () => {
  const tmp = tempDir('spencer-p2p-group-');
  const relay = await startRelay({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'relay.db'), stunBind: '127.0.0.1:0' });
  const nodes = ['Alice', 'Bob', 'Carol'].map(name => new Daemon({ dataDir: join(tmp.dir, name), config: { name, relay: relay.url, http: { host: '127.0.0.1', port: 0 }, model: { provider: 'fake' }, policy: { ...DEFAULT_POLICY, autoAcceptIncomingFiles: true } }, tuning: { p2p: { allowLoopback: true, cleanupOnStop: false } }, webRoot: null }));
  try {
    await Promise.all(nodes.map(n => n.start()));
    const [a, b, c] = nodes as [Daemon, Daemon, Daemon];
    const inv = await a.createInvite('group', 'Team');
    await b.acceptInvite(inv.link); await c.acceptInvite(inv.link);
    await waitFor(() => a.channels.peerHasFeature(inv.channel.id, b.identity.id, 'p2p-files/1') && b.channels.peerHasFeature(inv.channel.id, a.identity.id, 'p2p-files/1'), 'feature hello');
    const aa = new Api(a.port, a.token), bb = new Api(b.port, b.token);
    const data = randomBytes(5 * 1024 * 1024), path = join(tmp.dir, 'file.bin'); writeFileSync(path, data);
    const tr = await aa.sendFile(inv.channel.id, path, b.identity.id); await aa.transferAction(tr.tid, 'approve');
    await waitFor(async () => (await aa.transfer(tr.tid)).state === 'completed' && (await bb.transfer(tr.tid)).state === 'completed', 'transfer', 30000);
    const sent = await aa.transfer(tr.tid), received = await bb.transfer(tr.tid);
    assert.equal(sent.via, 'link'); assert.equal(received.via, 'link');
    assert.deepEqual(readFileSync(received.path!), data);
    assert.equal(c.transfers.list().length, 0); assert.equal(c.links?.status().active, 0);
  } finally { await Promise.all(nodes.map(n => n.stop())); await relay.close(); tmp.cleanup(); }
});
