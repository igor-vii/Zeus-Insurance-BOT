/**
 * F-09 fix (external audit 2026-10-25): outbound request guard (anti-SSRF).
 *
 * `/v1/requests` accepts an arbitrary client-supplied `target` URL that the
 * Secretariat later fetches server-side (discovery, execution, retrieval).
 * A syntactically valid URL is not a SAFE destination: without an egress
 * policy the endpoint can be abused as a proxy into loopback services, the
 * RFC1918 intranet, cloud metadata endpoints (169.254.169.254) and
 * redirect-based bypasses of such checks.
 *
 * Policy (env-configured):
 *   ZEUS_EGRESS_POLICY        "block-private" (default) | "allow-all"
 *                             — allow-all exists for local test rigs only;
 *   ZEUS_EGRESS_ALLOWED_HOSTS comma-separated hostnames/IPs exempt from the
 *                             private-range block (documented exceptions).
 *
 * Rules (block-private):
 *   - schemes http/https only;
 *   - DNS is resolved BEFORE the request and EVERY resolved address must be
 *     public (fail closed on resolution failure);
 *   - redirects are forbidden (redirect: "error") so a public host cannot
 *     bounce the request into a private range — re-issue a guarded request
 *     instead of following.
 */
import { lookup } from "node:dns/promises";
function egressPolicy() {
    const raw = String(process.env["ZEUS_EGRESS_POLICY"] ?? "block-private").trim().toLowerCase();
    return raw === "allow-all" ? "allow-all" : "block-private";
}
function egressAllowedHosts() {
    const raw = String(process.env["ZEUS_EGRESS_ALLOWED_HOSTS"] ?? "");
    return new Set(raw
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0));
}
/** IPv4 CIDR containment (no deps — addresses are dotted quads here). */
function ipv4InCidr(ip, cidr) {
    const [range, bitsRaw] = cidr.split("/");
    const bits = Number(bitsRaw);
    const toInt = (a) => a.split(".").reduce((acc, oct) => ((acc << 8) | (Number(oct) & 0xff)) >>> 0, 0);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((toInt(ip) & mask) >>> 0) === ((toInt(range) & mask) >>> 0);
}
function isV6(ip) {
    return ip.includes(":");
}
/** Normalize a compressed IPv6 into 8 hextets (zeros expanded). */
function expandV6(ipRaw) {
    let cleaned = ipRaw.replace(/^\[|\]$/g, "").split("%")[0]; // strip zone id
    // Normalize an embedded IPv4 dotted-quad tail (::ffff:127.0.0.1) into two
    // hextets BEFORE the :: expansion — otherwise the quad is miscounted as a
    // single group.
    const embeddedV4 = cleaned.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embeddedV4) {
        const q = embeddedV4[2].split(".").map(Number);
        if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
            return null;
        cleaned = embeddedV4[1] + `${(((q[0] << 8) | q[1]) >>> 0).toString(16)}:${(((q[2] << 8) | q[3]) >>> 0).toString(16)}`;
    }
    let head = [];
    let tail = [];
    if (cleaned.includes("::")) {
        const [l, r = ""] = cleaned.split("::");
        head = l ? l.split(":") : [];
        tail = r ? r.split(":") : [];
    }
    else {
        head = cleaned.split(":");
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 0)
        return null;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    if (groups.length !== 8)
        return null;
    return groups.map((g) => parseInt(g, 16).toString(16));
}
function v6InCidr(ip, cidrPrefix, bits) {
    const expanded = expandV6(ip);
    const prefixGroups = expandV6(cidrPrefix);
    if (!expanded || !prefixGroups)
        return false;
    const fullGroups = Math.floor(bits / 16);
    const remBits = bits % 16;
    for (let i = 0; i < fullGroups; i++) {
        if (expanded[i] !== prefixGroups[i])
            return false;
    }
    if (remBits > 0) {
        const mask = (0xffff << (16 - remBits)) & 0xffff;
        if ((parseInt(expanded[fullGroups], 16) & mask) !== (parseInt(prefixGroups[fullGroups], 16) & mask)) {
            return false;
        }
    }
    return true;
}
/**
 * True when the address must NOT be reachable through the public egress:
 * loopback, RFC1918, link-local (incl. cloud metadata), ULA, carrier NAT,
 * benchmark/reserved, unspecified, multicast.
 */
export function isPrivateOrReservedAddress(address) {
    const ip = address.replace(/^\[|\]$/g, "").split("%")[0];
    if (isV6(ip)) {
        const v6Blocked = [
            ["::1", 128], // loopback
            ["::", 128], // unspecified
            ["::ffff:0:0", 96], // IPv4-mapped (checked v4-style below, blocked here for safety)
            ["fe80::", 10], // link-local
            ["fc00::", 7], // unique local
            ["ff00::", 8], // multicast
            // R7-B10 (external audit 2026-10-26): translation/encapsulation
            // prefixes — an IPv6 literal here can reach IPv4 private space:
            ["64:ff9b::", 96], // NAT64 (RFC 6052) — well-known prefix
            ["2002::", 16], // 6to4 (RFC 3056) — embeds an IPv4 address
        ];
        if (v6Blocked.some(([prefix, bits]) => v6InCidr(ip, prefix, bits)))
            return true;
        const expanded = expandV6(ip);
        if (expanded && expanded.slice(0, 5).every((g) => g === "0") && expanded[5] === "ffff") {
            // ::ffff:a.b.c.d — evaluate the embedded IPv4.
            const hi = parseInt(expanded[6], 16);
            const lo = parseInt(expanded[7], 16);
            return isPrivateOrReservedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
        }
        return false;
    }
    const v4Blocked = [
        "0.0.0.0/8", // "this network" / unspecified
        "10.0.0.0/8", // RFC1918 private
        "100.64.0.0/10", // carrier-grade NAT
        "127.0.0.0/8", // loopback
        "169.254.0.0/16", // link-local (incl. 169.254.169.254 cloud metadata)
        "172.16.0.0/12", // RFC1918 private
        "192.0.0.0/24", // IETF protocol assignments
        "192.0.2.0/24", // TEST-NET-1
        "192.168.0.0/16", // RFC1918 private
        "198.18.0.0/15", // benchmarking
        "198.51.100.0/24", // TEST-NET-2
        "203.0.113.0/24", // TEST-NET-3
        "224.0.0.0/4", // multicast
        "240.0.0.0/4", // reserved (incl. broadcast)
    ];
    return v4Blocked.some((cidr) => ipv4InCidr(ip, cidr));
}
export class EgressBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = "EgressBlockedError";
    }
}
/**
 * Validate a client-supplied destination before any server-side fetch.
 * Throws EgressBlockedError when the destination violates the egress policy.
 */
export async function assertEgressAllowed(rawUrl) {
    if (egressPolicy() === "allow-all")
        return;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new EgressBlockedError(`EGRESS_BLOCKED: target is not a valid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new EgressBlockedError(`EGRESS_BLOCKED: only http/https targets are allowed, got ${parsed.protocol}`);
    }
    const allowedHosts = egressAllowedHosts();
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (allowedHosts.has(host))
        return;
    let addresses;
    try {
        addresses = await lookup(host, { all: true, verbatim: true });
    }
    catch (err) {
        throw new EgressBlockedError(`EGRESS_BLOCKED: DNS resolution failed for ${host} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!addresses || addresses.length === 0) {
        throw new EgressBlockedError(`EGRESS_BLOCKED: no addresses resolved for ${host}`);
    }
    const privateHit = addresses.find((a) => isPrivateOrReservedAddress(a.address));
    if (privateHit) {
        throw new EgressBlockedError(`EGRESS_BLOCKED: ${host} resolves to a private/reserved address (${privateHit.address}) — ` +
            `add it to ZEUS_EGRESS_ALLOWED_HOSTS if this destination is an approved exception`);
    }
}
/**
 * Guarded fetch for server-issued outbound requests: validates the
 * destination against the egress policy, then performs the request with
 * redirects FORBIDDEN (a redirect to another host would silently bypass the
 * DNS-level check). Callers receive the raw fetch Response.
 *
 * R7-B10 (external audit 2026-10-26): a default timeout now bounds every
 * server-issued fetch — previously only the seller-execution adapter armed
 * an AbortSignal, so a hung discovery/DEAD-code fetch could stall the
 * operation indefinitely. A caller-supplied signal wins; the default is
 * combined with it.
 */
const DEFAULT_EGRESS_TIMEOUT_MS = 15_000;
export async function egressFetch(url, init = {}) {
    await assertEgressAllowed(url);
    const callerSignal = init.signal;
    const timeoutSignal = AbortSignal.timeout(DEFAULT_EGRESS_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    return fetch(url, { ...init, signal, redirect: "error" });
}
//# sourceMappingURL=egress-guard.js.map