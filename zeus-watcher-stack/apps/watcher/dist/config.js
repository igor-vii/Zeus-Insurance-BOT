"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NETWORKS = void 0;
exports.NETWORKS = {
    'bot-chain': {
        chainId: 677,
        rpcs: ['https://rpc.botchain.ai'],
        insurance: '0x8D10C2c6C92b613C1938fe532f0e391044e76188',
        graphUrl: process.env.GRAPH_URL_BOT,
        quorum: 3,
        gasThresholdGwei: 150,
        minProfitMultiplier: 1.3,
    },
    'x-layer': {
        chainId: 196,
        rpcs: ['https://rpc.xlayer.tech'],
        insurance: '0x8D10C2c6C92b613C1938fe532f0e391044e76188',
        graphUrl: process.env.GRAPH_URL_XLAYER,
        quorum: 3,
        gasThresholdGwei: 80,
        minProfitMultiplier: 1.3,
    }
};
