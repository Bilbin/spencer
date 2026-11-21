import { test } from "node:test";
import assert from "node:assert/strict";
import { filterIncomingSdp, filterOutgoingSdp, extractDtlsFingerprint } from "../../src/p2p/sdp.ts";
const candidate = (ip: string, type = "host") => `a=candidate:1 1 udp 1 ${ip} 1234 typ ${type}\r\n`;
test("filters candidate addresses and caps incoming candidates", () => {
  const blocked = ["127.0.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "::ffff:127.0.0.1", "10.1.2.3", "fc00::1"];
  const input = blocked.map(ip => candidate(ip)).join("") + candidate("8.8.8.8").repeat(10);
  assert.equal(filterIncomingSdp(input, { allowPrivate: false }), candidate("8.8.8.8").repeat(8));
  assert.equal(filterOutgoingSdp(candidate("10.0.0.1") + candidate("2001:db8::1") + candidate("8.8.8.8"), { hideLocalAddresses: true }), candidate("8.8.8.8"));
  assert.match(filterOutgoingSdp(candidate("8.8.8.8", "srflx").replace("\r\n", " raddr 10.0.0.1 rport 123\r\n"), { hideLocalAddresses: true }), /raddr 0\.0\.0\.0 rport 0/);
  assert.equal(extractDtlsFingerprint("a=fingerprint:sha-256 aa:bb\r\n"), "SHA-256:AA:BB");
});
