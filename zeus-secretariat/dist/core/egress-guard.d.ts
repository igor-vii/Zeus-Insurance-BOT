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
export type EgressPolicy = "block-private" | "allow-all";
/**
 * True when the address must NOT be reachable through the public egress:
 * loopback, RFC1918, link-local (incl. cloud metadata), ULA, carrier NAT,
 * benchmark/reserved, unspecified, multicast.
 */
export declare function isPrivateOrReservedAddress(address: string): boolean;
export declare class EgressBlockedError extends Error {
    constructor(message: string);
}
/**
 * Validate a client-supplied destination before any server-side fetch.
 * Throws EgressBlockedError when the destination violates the egress policy.
 */
export declare function assertEgressAllowed(rawUrl: string): Promise<void>;
/**
 * Guarded fetch for server-issued outbound requests: validates the
 * destination against the egress policy, then performs the request with
 * redirects FORBIDDEN (a redirect to another host would silently bypass the
 * DNS-level check). Callers receive the raw fetch Response.
 */
export declare function egressFetch(url: string, init?: RequestInit): Promise<Response>;
//# sourceMappingURL=egress-guard.d.ts.map