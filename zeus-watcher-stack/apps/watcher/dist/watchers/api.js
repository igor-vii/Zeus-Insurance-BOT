"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiWatcher = void 0;
exports.apiWatcher = {
    name: 'api',
    async check(policy) {
        try {
            const apiUrl = process.env.API_URL;
            if (!apiUrl)
                throw new Error('API_URL not set');
            const resp = await fetch(`${apiUrl}/api/policies/${policy.policyId}/status`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!resp.ok)
                return { watcher: 'api', vote: 'abstain', reason: `HTTP ${resp.status}` };
            const data = await resp.json();
            if (data.deliveryFailed === true)
                return { watcher: 'api', vote: 'yes', reason: 'API: delivery failed' };
            if (data.delivered === true)
                return { watcher: 'api', vote: 'no', reason: 'API: delivered' };
            return { watcher: 'api', vote: 'abstain', reason: 'API: inconclusive' };
        }
        catch (err) {
            return { watcher: 'api', vote: 'abstain', reason: err.message };
        }
    }
};
