/**
 * Integration test — Zeus MCP server (POST /mcp)
 *
 * Requires the API server to be running on port 8080.
 * Run with:  pnpm test  (from api-server/)
 *   or:      node --import tsx/esm --test tests/mcp-server.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env["API_URL"] ?? "http://localhost:8080";
const MCP_URL = `${BASE_URL}/mcp`;

const EXPECTED_TOOLS = [
  "insurance_quote",
  "insurance_prepare_buy",
  "insurance_claim",
  "insurance_get_policies",
  "insurance_reserve_stats",
  "escrow_prepare_deposit",
  "escrow_prepare_confirm",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

async function mcpPost(body: object): Promise<{ data: unknown; status: number }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": `test-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  // MCP Streamable HTTP wraps responses in SSE events; extract the JSON data line.
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"));

  const json = dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : JSON.parse(text);
  return { data: json, status: res.status };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("MCP server — /mcp endpoint", () => {
  test("responds to tools/list and registers all 7 tools", async () => {
    const { data, status } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/list",
      id: "1",
    });

    assert.equal(status, 200, "Expected HTTP 200");

    const result = (data as { result?: { tools?: { name: string }[] } }).result;
    assert.ok(result, "Expected a result object");
    assert.ok(Array.isArray(result.tools), "Expected result.tools to be an array");

    const names = result.tools!.map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.includes(expected), `Missing tool: ${expected}`);
    }

    assert.equal(names.length, EXPECTED_TOOLS.length, `Expected exactly ${EXPECTED_TOOLS.length} tools`);
  });

  test("insurance_quote — returns riskScore and premiumAmount for a valid address", async () => {
    const { data } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "2",
      params: {
        name: "insurance_quote",
        arguments: {
          seller: "0x000000000000000000000000000000000000dEaD",
          amount: "1000000",
          maxRetries: 3,
        },
      },
    });

    const content = (data as { result?: { content?: { text: string }[] } }).result?.content;
    assert.ok(Array.isArray(content) && content.length > 0, "Expected content array");
    const parsed = JSON.parse(content![0].text);
    assert.ok("riskScore" in parsed, "Expected riskScore in response");
    assert.ok("premiumAmount" in parsed, "Expected premiumAmount in response");
    assert.equal(typeof parsed.riskScore, "number", "riskScore should be a number");
  });

  test("insurance_claim — returns valid calldata for policyId 0", async () => {
    const { data } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "3",
      params: {
        name: "insurance_claim",
        arguments: { policyId: "0" },
      },
    });

    const content = (data as { result?: { content?: { text: string }[] } }).result?.content;
    assert.ok(Array.isArray(content) && content.length > 0, "Expected content array");
    const parsed = JSON.parse(content![0].text);
    assert.ok(parsed.to?.startsWith("0x"), "Expected a contract address in `to`");
    assert.ok(parsed.data?.startsWith("0x"), "Expected hex calldata in `data`");
  });

  test("insurance_claim — rejects non-integer policyId", async () => {
    const { data } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "4",
      params: {
        name: "insurance_claim",
        arguments: { policyId: "abc" },
      },
    });

    const result = (data as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
    assert.ok(result?.isError === true, "Expected isError: true for invalid policyId");
  });

  test("escrow_prepare_deposit — returns calldata for valid inputs", async () => {
    const { data } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "5",
      params: {
        name: "escrow_prepare_deposit",
        arguments: {
          executor: "0x000000000000000000000000000000000000dEaD",
          amount: "5000000",
          timeoutSeconds: 3600,
        },
      },
    });

    const result = (data as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
    // If escrow contract is not configured the tool returns isError — that is also valid.
    if (result?.isError) {
      const text = result.content?.[0]?.text ?? "";
      assert.ok(
        text.includes("ZEUS_ESCROW_BOT_ADDRESS"),
        "Expected env-var guidance in error when contract not deployed",
      );
    } else {
      const parsed = JSON.parse(result!.content![0].text);
      assert.ok(parsed.to?.startsWith("0x"), "Expected contract address in `to`");
      assert.ok(parsed.data?.startsWith("0x"), "Expected hex calldata in `data`");
    }
  });

  test("insurance_reserve_stats — returns reserve data from chain", async () => {
    const { data } = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "6",
      params: { name: "insurance_reserve_stats", arguments: {} },
    });

    const result = (data as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
    // Chain call may fail in CI without RPC — only check shape when successful.
    if (!result?.isError) {
      const parsed = JSON.parse(result!.content![0].text);
      assert.ok("balance" in parsed, "Expected balance field");
      assert.ok("isAdequatelyFunded" in parsed, "Expected isAdequatelyFunded field");
    }
  });
});
