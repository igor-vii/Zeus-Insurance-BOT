/**
 * Controlled JSON-RPC mock for the Secretariat external-client test sandbox.
 * Deterministic, in-memory "chain" that reports settlement evidence for payments
 * settled by the facilitator mock (GET /_state?tx=... shared state).
 *
 * POST /            -> JSON-RPC (eth_chainId, eth_blockNumber, eth_getTransactionReceipt, eth_call, eth_getLogs)
 * GET  /_mine       -> facilitator mock calls this to register a mined tx
 * GET  /_state      -> { txs: {...} } for dump/debug
 */
import http from "node:http";

const port = Number(process.argv[2] || 18545);
const CHAIN_ID = "0x14a2f"; // 84532 base-sepolia
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = process.env.AUTHZ_USED_TOPIC; // keccak("AuthorizationUsed(address,bytes32)")

const txs = {}; // hash -> { blockNumber, asset, from(authorizer), to(payTo), value, nonce, logs }
let head = 1000n;

function pad32(addr) {
  return "0x" + addr.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET" && req.url.startsWith("/_mine")) {
    const u = new URL(req.url, "http://l");
    const hash = u.searchParams.get("hash");
    const asset = u.searchParams.get("asset");
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    const value = u.searchParams.get("value");
    const nonce = u.searchParams.get("nonce");
    head += 1n;
    const bn = head;
    const dataVal = BigInt(value).toString(16).padStart(64, "0");
    txs[hash] = {
      blockNumber: bn,
      logs: [
        { address: asset, topics: [TRANSFER_TOPIC, pad32(from), pad32(to)], data: "0x" + dataVal },
        { address: asset, topics: [AUTHORIZATION_USED_TOPIC.toLowerCase(), pad32(from), nonce.toLowerCase()], data: "0x" },
      ],
    };
    // keep advancing head so confirmations grow past finality quickly
    head += 20n;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hash, blockNumber: "0x" + bn.toString(16) }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/_state")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ head: head.toString(), txs }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let rpc;
    try { rpc = JSON.parse(body); } catch { res.writeHead(400); res.end("{}"); return; }
    const send = (result) => res.writeHead(200, { "content-type": "application/json" }) || res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, result }));
    const err = (message) => res.writeHead(200, { "content-type": "application/json" }) || res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, error: { code: -32000, message } }));
    const p = rpc.params || [];
    switch (rpc.method) {
      case "eth_chainId": return send(CHAIN_ID);
      case "eth_blockNumber": return send("0x" + head.toString(16));
      case "eth_getTransactionReceipt": {
        const t = txs[p[0]];
        if (!t) return send(null);
        return send({
          transactionHash: p[0],
          blockNumber: "0x" + t.blockNumber.toString(16),
          status: "0x1",
          logs: t.logs.map((l, i) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: "0x" + i.toString(16) })),
        });
      }
      case "eth_call": {
        // authorizationState(address,bytes32) -> used (nonzero) if tx known with matching nonce
        const data = (p[0] && p[0].data) || "";
        const selector = data.slice(0, 10);
        const nonceArg = "0x" + data.slice(74, 138).toLowerCase();
        const found = Object.values(txs).some((t) => t.logs.some((l) => l.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() && l.topics[2]?.toLowerCase() === nonceArg));
        if (selector === "0xa73e74c9" || true) {
          return send(found ? "0x0000000000000000000000000000000000000000000000000000000000000002" : "0x0000000000000000000000000000000000000000000000000000000000000000");
        }
        return send("0x");
      }
      case "eth_getLogs": {
        const crit = p[0] || {};
        const wantTopics = crit.topics || [];
        const out = [];
        for (const [hash, t] of Object.entries(txs)) {
          for (let i = 0; i < t.logs.length; i++) {
            const l = t.logs[i];
            if (crit.address && l.address.toLowerCase() !== String(crit.address).toLowerCase()) continue;
            let ok = true;
            for (let k = 0; k < wantTopics.length; k++) {
              const w = Array.isArray(wantTopics[k]) ? wantTopics[k] : [wantTopics[k]];
              if (w && !w.some((x) => String(x).toLowerCase() === String(l.topics[k]).toLowerCase())) { ok = false; break; }
            }
            if (ok) out.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: "0x" + t.blockNumber.toString(16), transactionHash: hash, logIndex: "0x" + i.toString(16) });
          }
        }
        return send(out);
      }
      default:
        return err("method not mocked: " + rpc.method);
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`[rpc-mock] listening on ${port}`));
