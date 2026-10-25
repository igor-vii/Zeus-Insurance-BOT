/**
 * F-09 regression tests (external audit 2026-10-25): outbound egress guard.
 *
 * The Secretariat fetches client-supplied URLs server-side. The guard must
 * block loopback / RFC1918 / link-local (cloud metadata) / reserved
 * destinations by IP after DNS resolution, forbid other schemes, fail closed
 * on DNS failure, and honor the documented escapes:
 *   ZEUS_EGRESS_POLICY=allow-all        (local test rigs)
 *   ZEUS_EGRESS_ALLOWED_HOSTS=a,b,c     (approved exceptions)
 *
 * Note: DNS-resolvable tests use IP literals (dns.lookup of a literal never
 * touches the network), so the suite runs hermetically.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  assertEgressAllowed,
  isPrivateOrReservedAddress,
  EgressBlockedError,
} from '../src/core/egress-guard';

const ORIGINAL_ENV = { ...process.env };

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({
    ZEUS_EGRESS_POLICY: undefined,
    ZEUS_EGRESS_ALLOWED_HOSTS: undefined,
  });
});

afterEach(() => {
  setEnv(ORIGINAL_ENV);
});

describe('isPrivateOrReservedAddress', () => {
  it('blocks loopback, RFC1918, metadata, CGNAT, reserved, multicast', () => {
    for (const ip of [
      '127.0.0.1', '127.8.8.8',
      '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '169.254.169.254', '169.254.1.1',
      '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1',
      '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateOrReservedAddress(ip)).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1']) {
      expect(isPrivateOrReservedAddress(ip)).toBe(false);
    }
  });

  it('blocks IPv6 loopback/ULA/link-local and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateOrReservedAddress(ip)).toBe(true);
    }
    expect(isPrivateOrReservedAddress('2606:4700::1111')).toBe(false);
  });
});

describe('assertEgressAllowed (block-private, default)', () => {
  it('blocks loopback / private / metadata / CGNAT destinations', async () => {
    for (const url of [
      'http://127.0.0.1:8080/seller',
      'http://10.0.0.5/internal',
      'http://192.168.1.10/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/y',
    ]) {
      await expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
  });

  it('blocks non-http schemes', async () => {
    await expect(assertEgressAllowed('file:///etc/passwd')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(assertEgressAllowed('gopher://8.8.8.8')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('allows public IP-literal destinations', async () => {
    await expect(assertEgressAllowed('https://8.8.8.8/dns-query')).resolves.toBeUndefined();
    await expect(assertEgressAllowed('https://1.1.1.1/x')).resolves.toBeUndefined();
  });

  it('fails closed on unresolvable hostnames', async () => {
    await expect(assertEgressAllowed('http://definitely-not-a-real-host-zeus.invalid/')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('ZEUS_EGRESS_ALLOWED_HOSTS exempts approved private destinations', async () => {
    setEnv({ ZEUS_EGRESS_ALLOWED_HOSTS: '10.0.0.5, 192.168.1.10' });
    await expect(assertEgressAllowed('http://10.0.0.5/seller')).resolves.toBeUndefined();
    await expect(assertEgressAllowed('http://192.168.1.10/seller')).resolves.toBeUndefined();
    // Unlisted privates stay blocked.
    await expect(assertEgressAllowed('http://10.0.0.6/seller')).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe('assertEgressAllowed (allow-all policy for test rigs)', () => {
  it('permits everything, including loopback', async () => {
    setEnv({ ZEUS_EGRESS_POLICY: 'allow-all' });
    await expect(assertEgressAllowed('http://127.0.0.1:9977/facilitator')).resolves.toBeUndefined();
    await expect(assertEgressAllowed('http://169.254.169.254/')).resolves.toBeUndefined();
  });
});
