"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const graph_1 = require("./graph");
const engine_1 = require("./engine");
const signer_1 = require("./signer");
const config_1 = require("./config");
const signer = new signer_1.ObservationSigner(process.env.PRIVATE_KEY);
async function tick() {
    for (const [name, cfg] of Object.entries(config_1.NETWORKS)) {
        console.log(`[${name}] Polling...`);
        const policies = cfg.graphUrl
            ? await (0, graph_1.fetchExpiringPolicies)(cfg.graphUrl)
            : [];
        for (const policy of policies) {
            const result = await (0, engine_1.evaluateAndSign)(policy, signer);
            console.log(`Policy ${policy.policyId}: ${result.reason}`);
            if (result.observation === null)
                continue; // abstain — не отправляем
            await fetch(`${process.env.API_URL}/observations/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chainId: result.chainId,
                    policyId: result.policyId,
                    observation: result.observation,
                }),
            });
        }
    }
}
// Run immediately, then every 2 minutes
tick();
node_cron_1.default.schedule('*/2 * * * *', tick);
