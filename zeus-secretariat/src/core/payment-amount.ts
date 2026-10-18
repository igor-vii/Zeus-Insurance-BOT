/**
 * TASK S-VERIFY-1: exact EIP-3009 amount binding.
 *
 * Money semantics (traced end-to-end):
 *  - The seller's x402 V2 challenge exposes `accepted.amount` as an integer
 *    atomic-unit string of the payment token (e.g. "1000" = 1000 USDC
 *    attobase-units on Base Seppolia test fixture).
 *  - The state machine persists that exact string into
 *    `DurablePaymentIntent.value` (`value: requirement.amount`) without any
 *    unit conversion; downstream consumers treat it as an integer atomic-unit
 *    value: the EIP-712 signer encodes it as `uint256` via
 *    `BigInt(authorization.value)`, and the reconciliation engine matches
 *    Transfer logs with `BigInt(intent.value)`.
 *  - PostgreSQL stores the column as `numeric(38,6)` and the driver returns
 *    it as a fixed-scale decimal string (e.g. "1000.000000"). For this field
 *    the fractional part is storage padding only: no code path ever writes a
 *    non-integer value into `payment_intents.value`.
 *
 * Therefore two decimal strings denote the same monetary value exactly when
 * their integer atomic-unit values are equal. Comparison must be exact
 * (bigint), never JavaScript `Number`, never rounding/truncation, and must
 * reject malformed, negative, or fractional inputs.
 */

/**
 * Parses a decimal string into an exact bigint number of atomic units.
 *
 * Accepted forms:
 *  - canonical unsigned integer string ("1000", "0");
 *  - unsigned decimal-fraction string whose fractional digits are all zero
 *    ("1000.000000") — accepted only to compensate the PostgreSQL
 *    numeric(38,6) fixed-scale serialization of the same integer value.
 *
 * Rejected forms (returns null):
 *  - anything not matching ^\d+(\.\d+)?$ (signs, exponents, hex, whitespace);
 *  - fractional values for this integer uint256 domain ("1000.5");
 *  - non-string input.
 */
export function parseExactAtomicAmount(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return null;
  const [intPart, fracPart] = value.split(".");
  // Canonical unsigned integer form: "0" or [1-9][0-9]* — no leading zeros.
  if (!/^(0|[1-9][0-9]*)$/.test(intPart)) return null;
  if (fracPart !== undefined && !/^[0]+$/.test(fracPart)) {
    // Fractional atomic units cannot exist in the uint256 EIP-3009 domain.
    return null;
  }
  try {
    return BigInt(intPart);
  } catch {
    return null;
  }
}

/**
 * Exact money equality for persisted-vs-signed payment amounts.
 *
 * Both sides must parse as exact atomic-unit integers; otherwise the
 * comparison fails closed (false). This preserves the payment limit: an
 * unparseable or malformed amount can never bind.
 */
export function sameExactAmount(left: unknown, right: unknown): boolean {
  const leftUnits = parseExactAtomicAmount(left);
  if (leftUnits === null) return false;
  const rightUnits = parseExactAtomicAmount(right);
  if (rightUnits === null) return false;
  return leftUnits === rightUnits;
}
