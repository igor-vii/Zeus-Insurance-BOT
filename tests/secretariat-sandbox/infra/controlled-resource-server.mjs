/**
 * Controlled Resource Server — deterministic counterparty for the Secretariat sandbox.
 * Modes (selected via ?mode= or X-Test-Mode header on POST /execute):
 *   HAPPY          -> 200 + result
 *   TIMEOUT        -> accept request, never respond (hang)
 *   RESPONSE_LOST  -> execute internally, then destroy the response (socket abort)
 *   EXEC_FAILURE   -> 500 { error: "execution_failed" }
 *   RETRY          -> first call hangs; second call (same Idempotency-Key) returns stored result
 *   IDEMPOTENT     -> same Idempotency-Key => replay stored result, no duplicate execution
 * Owns a ground-truth ledger (NOT visible to clients).
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const port = Number(process.argv[2] || 18700);
const LEDGER_PATH = process.env.LEDGER_PATH || "/workspace/evidence/secretariat-test/resource-server/ledger.json";
const ledger = { payments: [], executions: [], requests: [], responses: [] };
const seenKeys = {}; // idempotencyKey -> { count, result }

function saveLedger() {
  try { fs.mkdirSync(LEDGER_PATH, { recursive: true }); fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2)); } catch {}
}
function logReq(entry) { ledger.requests.push({ at: Date.now(), ...entry }); saveLedger(); }
function logExec(entry) { ledger.executions.push({ at: Date.now(), ...entry }); saveLedger(); }

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/_ledger") { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(ledger,null,2)); return; }
  if (req.method === "GET" && req.url.startsWith("/reset")) {
    ledger.payments.length=0; ledger.executions.length=0; ledger.requests.length=0; ledger.responses.length=0;
    for (const k of Object.keys(seenKeys)) delete seenKeys[k];
    saveLedger(); res.writeHead(200); res.end(JSON.stringify({ok:true})); return;
  }
  // Discovery endpoint: resource advertises x402 payment requirement (402)
  if (req.method === "GET" && req.url.startsWith("/resource")) {
    const mode = new URL(req.url,"http://l").searchParams.get("mode") || "HAPPY";
    logReq({ method:"GET", path:req.url, headers:{}, body:null, stage:"discovery", mode });
    const challenge = {
      x402Version: 2,
      accepts: [{
        scheme: "exact", network: "base-sepolia",
        maxAmountRequired: "100000", // 0.1 USDC
        resource: `http://127.0.0.1:${port}/execute?mode=${mode}`,
        description: "Controlled test execution",
        mimeType: "application/json", payTo: process.env.SELLER_PAY_TO || "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60, asset: process.env.TEST_USDC || "0x036CbD53842c942c0a9d39f23520231D3dF71be4",
        extra: { name: "USDC", version: "2" },
        authorizationType: "EIP3009"
      }],
      ...(mode !== "NONE" ? {} : {})
    };
    const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
    res.writeHead(402, { "X-PAYMENT-REQUIRED": b64, "Content-Type": "application/json", "X-Recovery-Capability": (mode==="RETRY"||mode==="IDEMPOTENT") ? "EXECUTION_IDEMPOTENT" : "RESULT_RETRIEVAL" });
    res.end(JSON.stringify(challenge));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/execute")) {
    const u = new URL(req.url, "http://l");
    const mode = u.searchParams.get("mode") || req.headers["x-test-mode"] || "HAPPY";
    const idem = req.headers["idempotency-key"] || null;
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      logReq({ method:"POST", path:req.url, headers:{ "idempotency-key": idem, "x-payment": req.headers["x-payment"]?"PRESENT":undefined, "x-recovery-capability": undefined }, body: safeParse(body), mode });
      const execId = crypto.randomUUID();
      const result = { ok: true, execId, mode, payload: { delivered: true, data: "controlled-resource-result" }, executedAt: Date.now() };
      switch (mode) {
        case "TIMEOUT":
          logExec({ execId, mode, status:"STARTED_NO_RESPONSE", idempotencyKey: idem });
          // never respond — socket stays open
          return;
        case "RESPONSE_LOST":
          logExec({ execId, mode, status:"COMPLETED_RESPONSE_DESTROYED", idempotencyKey: idem });
          req.socket.destroy(); // response destroyed after real execution
          return;
        case "EXEC_FAILURE":
          logExec({ execId, mode, status:"FAILED", idempotencyKey: idem });
          res.writeHead(500, {"content-type":"application/json"});
          res.end(JSON.stringify({ ok:false, error:"execution_failed", execId }));
          return;
        case "RETRY": {
          const s = idem ? seenKeys[idem] : null;
          if (!s) {
            if (idem) seenKeys[idem] = { count: 1, result };
            logExec({ execId, mode, status:"FIRST_ATTEMPT_HANG", idempotencyKey: idem });
            return; // hang first attempt
          }
          s.count += 1;
          logExec({ execId, mode, status:"RETRY_SERVED", attempts: s.count, idempotencyKey: idem });
          res.writeHead(200, {"content-type":"application/json"});
          res.end(JSON.stringify(s.result));
          return;
        }
        case "IDEMPOTENT": {
          const s = idem ? seenKeys[idem] : null;
          if (s) {
            s.count += 1;
            logExec({ execId: s.result.execId, mode, status:"REPLAY_NO_DUPLICATE", attempts: s.count, idempotencyKey: idem });
            res.writeHead(200, {"content-type":"application/json"});
            res.end(JSON.stringify(s.result));
            return;
          }
          if (idem) seenKeys[idem] = { count: 1, result };
          logExec({ execId, mode, status:"COMPLETED", idempotencyKey: idem });
          res.writeHead(200, {"content-type":"application/json"});
          res.end(JSON.stringify(result));
          return;
        }
        default: // HAPPY
          logExec({ execId, mode:"HAPPY", status:"COMPLETED", idempotencyKey: idem });
          res.writeHead(200, {"content-type":"application/json","X-Execution-Id":execId});
          res.end(JSON.stringify(result));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
function safeParse(s){ try { return JSON.parse(s); } catch { return s; } }
server.listen(port, "127.0.0.1", () => console.log(`[controlled-resource-server] listening :${port}`));
