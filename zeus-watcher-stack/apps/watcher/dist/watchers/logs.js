"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logWatcher = void 0;
const ethers_1 = require("ethers");
const DELIVERY_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
exports.logWatcher = {
    name: 'logs',
    async check(policy, cfg) {
        try {
            const provider = new ethers_1.JsonRpcProvider(cfg.rpcs[0]);
            const current = await provider.getBlockNumber();
            const logs = await provider.getLogs({
                address: cfg.insurance,
                topics: [
                    DELIVERY_TOPIC,
                    null,
                    '0x' + BigInt(policy.policyId).toString(16).padStart(64, '0'),
                ],
                fromBlock: Math.max(0, current - 50000),
                toBlock: current,
            });
            if (logs.length > 0) {
                const success = logs[0].data !== '0x' + '0'.repeat(63) + '0';
                return success
                    ? { watcher: 'logs', vote: 'no', reason: 'Delivery event: success' }
                    : { watcher: 'logs', vote: 'yes', reason: 'Delivery event: failure' };
            }
            return { watcher: 'logs', vote: 'yes', reason: 'No delivery event' };
        }
        catch (err) {
            return { watcher: 'logs', vote: 'abstain', reason: err.message };
        }
    }
};
