import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── We test pure/exported functions directly ──────────────────────────────────
// fetchHumi makes a real network call, so we mock globalThis.fetch per test.

import {
  fetchHumi,
  getHumiMultiplier,
  calculateRiskScore,
  type SellerHistory,
} from "../src/services/pricing.js";

const VALID_ADDR = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ZERO_HISTORY: SellerHistory = { totalPolicies: 0, failedPolicies: 0, avgRiskScore: 0 };

// ── fetchHumi ─────────────────────────────────────────────────────────────────
describe("fetchHumi", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mock.restoreAll();
  });

  test("returns HUMI value from successful API response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ humi: 75 }),
    }));
    const humi = await fetchHumi(VALID_ADDR);
    assert.equal(humi, 75);
  });

  test("returns fallback 50 when API returns non-ok status", async () => {
    mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503 }));
    const humi = await fetchHumi(VALID_ADDR);
    assert.equal(humi, 50);
  });

  test("returns fallback 50 when fetch throws (network error)", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("network error");
    });
    const humi = await fetchHumi(VALID_ADDR);
    assert.equal(humi, 50);
  });

  test("returns fallback 50 when humi field is missing in response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ someOtherField: 42 }),
    }));
    const humi = await fetchHumi(VALID_ADDR);
    assert.equal(humi, 50);
  });

  test("returns fallback 50 when humi value is out of range", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ humi: 150 }),
    }));
    const humi = await fetchHumi(VALID_ADDR);
    assert.equal(humi, 50);
  });
});

// ── getHumiMultiplier ─────────────────────────────────────────────────────────
describe("getHumiMultiplier", () => {
  const cases: [number, number][] = [
    [100, 0.70],  // HUMI >= 80 → very reliable
    [80,  0.70],
    [79,  0.85],  // HUMI >= 60
    [60,  0.85],
    [59,  1.00],  // HUMI >= 40 → neutral
    [40,  1.00],
    [39,  1.50],  // HUMI >= 20
    [20,  1.50],
    [19,  2.00],  // HUMI < 20 → high risk
    [0,   2.00],
  ];

  for (const [humi, expected] of cases) {
    test(`HUMI ${humi} → multiplier ${expected}`, () => {
      assert.equal(getHumiMultiplier(humi), expected);
    });
  }
});

// ── calculateRiskScore with HUMI integration ──────────────────────────────────
describe("calculateRiskScore — HUMI integration", () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  function mockHumi(humi: number) {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ humi }),
    }));
  }

  test("fallback HUMI=50 produces neutral mid-range score", async () => {
    // Simulate API failure → fallback 50 → weight 0.20, multiplier 1.00
    mock.method(globalThis, "fetch", async () => { throw new Error("down"); });
    const score = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);
    assert.ok(score >= 0.1 && score <= 5.0, `score ${score} out of range`);
  });

  test("HUMI=90 (multiplier 0.70, weight 0.25) lowers risk score vs HUMI=10 (2.00, weight 0.15)", async () => {
    mockHumi(90);
    const highHumi = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);

    mock.restoreAll();
    mockHumi(10);
    const lowHumi = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);

    assert.ok(
      highHumi < lowHumi,
      `Expected highHumi (${highHumi}) < lowHumi (${lowHumi})`,
    );
  });

  test("HUMI weight HUMI_WEIGHT_HIGH: score shifts by 0.25 factor", async () => {
    // humi = 75 → weight 0.25, multiplier 0.85
    // With ZERO_HISTORY and retries=0: modelRisk = min(5, 1+0*0.5) = 1.0
    // baseScore = 2*0.4 + 2*0.3 + 1*0.2 + 2*0.1 = 0.8+0.6+0.2+0.2 = 1.80
    // rawScore  = 1.80 * 0.75 + 0.85 * 0.25 = 1.35 + 0.2125 = 1.5625
    mockHumi(75);
    const score = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);
    assert.ok(Math.abs(score - 1.5625) < 0.001, `Expected ~1.5625, got ${score}`);
  });

  test("HUMI weight HUMI_WEIGHT_MEDIUM: score shifts by 0.20 factor", async () => {
    // humi = 40 → weight 0.20, multiplier 1.00
    // baseScore = 1.80; rawScore = 1.80 * 0.80 + 1.00 * 0.20 = 1.44 + 0.20 = 1.64
    mockHumi(40);
    const score = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);
    assert.ok(Math.abs(score - 1.64) < 0.001, `Expected ~1.64, got ${score}`);
  });

  test("HUMI weight HUMI_WEIGHT_LOW: score shifts by 0.15 factor", async () => {
    // humi = 10 → weight 0.15, multiplier 2.00
    // baseScore = 1.80; rawScore = 1.80 * 0.85 + 2.00 * 0.15 = 1.53 + 0.30 = 1.83
    mockHumi(10);
    const score = await calculateRiskScore(VALID_ADDR, 1_000_000n, 0, ZERO_HISTORY);
    assert.ok(Math.abs(score - 1.83) < 0.001, `Expected ~1.83, got ${score}`);
  });

  test("score stays within [0.1, 5.0] for extreme inputs", async () => {
    mockHumi(0);
    const history: SellerHistory = { totalPolicies: 100, failedPolicies: 100, avgRiskScore: 5.0 };
    const score = await calculateRiskScore(VALID_ADDR, 1_000_000n, 10, history);
    assert.ok(score >= 0.1 && score <= 5.0, `score ${score} out of bounds`);
  });

  test("rejects invalid seller address", async () => {
    await assert.rejects(
      () => calculateRiskScore("invalid", 1_000_000n, 0, ZERO_HISTORY),
      /Invalid seller address format/,
    );
  });
});
