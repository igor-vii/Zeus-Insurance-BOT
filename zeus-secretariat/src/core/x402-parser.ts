/**
 * Zeus Secretariat V0 - x402 Challenge Parser
 * 
 * Parses x402 v2 Payment Requirements from HTTP 402 responses.
 * Priority: PAYMENT-REQUIRED header > JSON body.
 */

export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

export interface X402Challenge {
  accepts: X402Accept[];
  metadata?: Record<string, unknown>;
}

export class X402Parser {
  /**
   * Parse payment requirements from a 402 Response.
   * Handles both Base64 headers and JSON bodies safely.
   */
  static async parseResponse(response: Response): Promise<X402Accept[]> {
    // Priority 1: Check for standard x402 header (Base64 encoded JSON)
    const paymentHeader = response.headers.get('PAYMENT-REQUIRED');
    if (paymentHeader) {
      try {
        const jsonStr = atob(paymentHeader);
        const challenge: X402Challenge = JSON.parse(jsonStr);
        if (challenge.accepts && challenge.accepts.length > 0) {
          return challenge.accepts;
        }
      } catch (e) {
        console.warn('Failed to parse PAYMENT-REQUIRED header', e);
      }
    }

    // Priority 1b (R0 repair): legacy `X-Payment-Required` key=value header
    // ("amount='0.5'; asset='MOCK'; network='mock-network'; payee='seller123'").
    // Sellers and test harnesses in this repository still emit this legacy
    // challenge form; accepting it as a fallback is additive and cannot shadow
    // the standard base64-JSON header above.
    const legacyHeader =
      response.headers.get('X-Payment-Required') ??
      response.headers.get('X-PAYMENT-REQUIRED');
    if (legacyHeader) {
      const legacy = X402Parser.parseLegacyHeader(legacyHeader);
      if (legacy) return [legacy];
    }

    // Priority 2: Check response body (JSON)
    // Note: We assume the response body hasn't been consumed yet or is available.
    try {
      const body = await response.json();
      return this.parseFromJSON(body);
    } catch (e) {
      throw new Error('No valid x402 challenge found in headers or body');
    }
  }

  /**
   * R0 repair: parse the legacy key=value challenge header into a canonical
   * X402Accept. Returns null when the header does not carry enough fields.
   */
  static parseLegacyHeader(raw: string): X402Accept | null {
    const fields: Record<string, string> = {};
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const key = pair.slice(0, idx).trim().toLowerCase();
      let value = pair.slice(idx + 1).trim();
      // strip surrounding quotes (single or double)
      const q = value.match(/^['"](.*)['"]$/);
      if (q) value = q[1];
      if (key) fields[key] = value;
    }
    const network = fields['network'];
    const asset = fields['asset'];
    const amount = fields['amount'] ?? fields['maxamountrequired'] ?? fields['max-amount-required'];
    const payTo = fields['payee'] ?? fields['payto'];
    if (!network || !amount || !payTo) return null;
    return {
      scheme: 'exact',
      network,
      asset: asset ?? '',
      amount,
      payTo,
    };
  }

  /**
   * Parse from a pre-fetched JSON object.
   */
  static parseFromJSON(body: unknown): X402Accept[] {
    if (!body || typeof body !== 'object') return [];
    
    const challenge = body as X402Challenge;
    if (Array.isArray(challenge.accepts)) {
      return challenge.accepts.filter(a => 
        a.scheme && a.network && a.amount && a.payTo
      );
    }
    
    return [];
  }
}
