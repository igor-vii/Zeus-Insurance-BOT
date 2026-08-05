"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcWatcher = void 0;
const ethers_1 = require("ethers");
const SELECTORS = { policies: '0x0d8e3e8c' };
function encodeUint256(value) {
    return BigInt(value).toString(16).padStart(64, '0');
}
exports.rpcWatcher = {
    name: 'rpc',
    async check(policy, cfg) {
        if (cfg.rpcs.length < 2) {
            return { watcher: 'rpc', vote: 'abstain', reason: 'No alternative RPC' };
        }
        try {
            const p1 = new ethers_1.JsonRpcProvider(cfg.rpcs[0]);
            const p2 = new ethers_1.JsonRpcProvider(cfg.rpcs[1]);
            const data = SELECTORS.policies + encodeUint256(policy.policyId);
            const [r1, r2] = await Promise.all([
                p1.call({ to: cfg.insurance, data }),
                p2.call({ to: cfg.insurance, data }),
            ]);
            const h1 = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(r1));
            const h2 = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(r2));
            if (h1 === h2)
                return { watcher: 'rpc', vote: 'no', reason: 'RPCs agree' };
            return { watcher: 'rpc', vote: 'yes', reason: 'RPC mismatch detected' };
        }
        catch (err) {
            return { watcher: 'rpc', vote: 'abstain', reason: err.message };
        }
    }
};
