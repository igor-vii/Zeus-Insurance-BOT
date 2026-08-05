"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateAndSign = evaluateAndSign;
const api_1 = require("./watchers/api");
const logs_1 = require("./watchers/logs");
const gas_1 = require("./watchers/gas");
const okx_1 = require("./watchers/okx");
const rpc_1 = require("./watchers/rpc");
const config_1 = require("./config");
const WATCHERS = [api_1.apiWatcher, logs_1.logWatcher, gas_1.gasWatcher, okx_1.okxWatcher, rpc_1.rpcWatcher];
async function evaluateAndSign(policy, signer) {
    const cfg = Object.values(config_1.NETWORKS).find(n => n.chainId === policy.chainId);
    let yes = 0, no = 0;
    const reasons = [];
    const results = await Promise.allSettled(WATCHERS.map(w => w.check(policy, cfg)));
    for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const name = WATCHERS[i].name;
        if (res.status === 'rejected') {
            reasons.push(`${name}: abstain (${res.reason.message})`);
            continue;
        }
        if (res.value.vote === 'yes') {
            yes++;
            reasons.push(`${name}: yes`);
        }
        else if (res.value.vote === 'no') {
            no++;
            reasons.push(`${name}: no`);
        }
        else
            reasons.push(`${name}: abstain`);
    }
    // Вето: если хоть один watcher сказал "no" — отправляем status=0 (reject)
    // Если >=2 yes (контракту нужно 2 из 3 для payout) — отправляем status=1
    // Но мы не знаем, сколько уже голосов on-chain. Отправляем наш вердикт.
    let status;
    let reason;
    if (no > 0) {
        status = 0;
        reason = `Vetoed: ${reasons.join('; ')}`;
    }
    else if (yes >= 2) {
        status = 1;
        reason = `Payout: ${reasons.join('; ')}`;
    }
    else {
        return { policyId: policy.policyId, chainId: policy.chainId, observation: null, reason: `Abstain: ${reasons.join('; ')}` };
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const obs = await signer.signObservation({
        policyId: policy.policyId,
        buyer: policy.buyer,
        seller: policy.seller,
        timestamp,
        status,
    });
    return {
        policyId: policy.policyId,
        chainId: policy.chainId,
        observation: obs,
        reason,
    };
}
