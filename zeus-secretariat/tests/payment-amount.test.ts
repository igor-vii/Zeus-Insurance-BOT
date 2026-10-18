/**
 * TASK S-VERIFY-1 — targeted tests for exact EIP-3009 amount binding.
 */
import { sameExactAmount, parseExactAtomicAmount } from "../src/core/payment-amount";

describe("parseExactAtomicAmount", () => {
  test("accepts canonical unsigned integers", () => {
    expect(parseExactAtomicAmount("1000")).toBe(1000n);
    expect(parseExactAtomicAmount("0")).toBe(0n);
  });

  test("accepts zero-padded fractional part (PostgreSQL numeric(38,6) form)", () => {
    expect(parseExactAtomicAmount("1000.000000")).toBe(1000n);
    expect(parseExactAtomicAmount("0.000000")).toBe(0n);
  });

  test("rejects non-zero fractional parts", () => {
    expect(parseExactAtomicAmount("1000.5")).toBeNull();
    expect(parseExactAtomicAmount("1000.000001")).toBeNull();
  });

  test("rejects negative, signed, exponent, hex, whitespace and non-string forms", () => {
    for (const bad of [
      "-1000", "+1000", "1e3", "1E3", "0x3e8", "1_000", " 1000", "1000 ",
      "", ".", ".5", "1000.", "1000.0.0", "NaN", "Infinity",
    ]) {
      expect(parseExactAtomicAmount(bad)).toBeNull();
    }
    expect(parseExactAtomicAmount(1000)).toBeNull();
    expect(parseExactAtomicAmount(null)).toBeNull();
    expect(parseExactAtomicAmount(undefined)).toBeNull();
  });
});

describe("sameExactAmount", () => {
  test('T1: "1000" equals "1000.000000"', () => {
    expect(sameExactAmount("1000", "1000.000000")).toBe(true);
    expect(sameExactAmount("1000.000000", "1000")).toBe(true);
  });

  test('T2: "1000" does not equal "1001.000000"', () => {
    expect(sameExactAmount("1000", "1001.000000")).toBe(false);
    expect(sameExactAmount("1000.000000", "1001")).toBe(false);
  });

  test("T3: fractional value against integer signature domain is rejected on both sides", () => {
    expect(sameExactAmount("1000.5", "1000.5")).toBe(false);
    expect(sameExactAmount("1000", "1000.5")).toBe(false);
  });

  test("T4: values beyond Number.MAX_SAFE_INTEGER compare exactly", () => {
    const big = "18446744073709551617"; // 2^64 + 1
    expect(sameExactAmount(big, `${big}.000000`)).toBe(true);
    // differs only in the digit lost by float64 rounding
    expect(sameExactAmount(big, "18446744073709551616")).toBe(false);
    expect(sameExactAmount(big, "18446744073709551618")).toBe(false);
  });

  test("T5: negative and malformed values fail closed even when identical", () => {
    expect(sameExactAmount("-1000", "-1000")).toBe(false);
    expect(sameExactAmount("", "")).toBe(false);
    expect(sameExactAmount("abc", "abc")).toBe(false);
    expect(sameExactAmount("1e3", "1000")).toBe(false);
  });

  test("leading zeros are rejected as non-canonical", () => {
    expect(sameExactAmount("01000", "1000")).toBe(false);
  });
});
