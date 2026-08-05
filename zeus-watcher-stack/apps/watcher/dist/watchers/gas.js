"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gasWatcher = void 0;
const ethers_1 = require("ethers");
exports.gasWatcher = {
    name: 'gas',
    async check(policy, cfg) {
        try {
            const provider = new ethers_1.JsonRpcProvider(cfg.rpcs[0]);
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice ?? 0n;
            // submitObservation ~ 80k gas (SSTORE + ECDSA recover)
            const estimatedGas = 80000n;
            const cost = gasPrice * estimatedGas;
            // Если газ слишком дорогой даже для отправки observation — abstain
            // Но observation дешёвая, так что порог ниже
            const maxCost = BigInt(policy.premium) / 10n; // Не тратим >10% premium на газ
            if (cost > maxCost) {
                return { watcher: 'gas', vote: 'abstain', reason: `Gas ${cost} > 10% of premium` };
            }
            return { watcher: 'gas', vote: 'abstain', reason: `Gas acceptable` };
        }
        catch (err) {
            return { watcher: 'gas', vote: 'abstain', reason: err.message };
        }
    }
};
