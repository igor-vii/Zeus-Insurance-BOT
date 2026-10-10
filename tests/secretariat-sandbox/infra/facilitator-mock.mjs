/**
 * Controlled x402 facilitator mock for the Secretariat external-client sandbox.
 * POST /settle  { paymentHeader(base64 V2 payload), resource, network }
 *   -> decodes payload, "mines" a settlement tx into BOTH rpc mocks, returns { transactionHash }.
 * Deterministic: one settle call per paymentHeader => one unique tx hash (sha256 of header).
 */
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] || 18650);
const RPCS = (process.env.RPC_MOCK_URLS || "http://127.0.0.1:18545,http://127.0.0.1:18546").split(",");
const ledger = { settlements: [], requests: [] };

async function mineToRpc(tx) {
  const q = new URLSearchParams({ hash: tx.hash, asset: tx.asset, from: tx.from, to: tx.to, value: tx.value, nonce: tx.nonce });
  for (const base of RPCS) {
    try { await fetch(`${base}/_mine?${q.toString()}`); } catch (e) { console.error("[facilitator-mock] mine failed", base, String(e)); }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/_ledger") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ledger, null, 2));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/settle")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return; }
    ledger.requests.push({ at: Date.now(), resource: parsed.resource, network: parsed.network });
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parsed.paymentHeader, "base64").toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "cannot decode paymentHeader" }));
      return;
    }
    const auth = payload?.payload?.authorization;
    if (!auth || !payload?.accepted) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "malformed V2 payload" }));
      return;
    }
    const hash = "0x" + crypto.createHash("sha256").update(parsed.paymentHeader).digest("hex");
    const tx = { hash, asset: payload.accepted.asset, from: auth.from, to: auth.to, value: auth.value, nonce: auth.nonce };
    await mineToRpc(tx);
    ledger.settlements.push({ at: Date.now(), txHash: hash, from: auth.from, to: auth.to, value: auth.value, nonce: auth.nonce, network: parsed.network, resource: parsed.resource });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, transactionHash: hash, network: parsed.network, status: "settled" }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`[facilitator-mock] listening on ${port}`));
