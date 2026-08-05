export const NETWORKS = {
  'bot-chain': {
    rpc: 'https://rpc.botchain.ai',
    insurance: '0x8D10C2c6C92b613C1938fe532f0e391044e76188',
    reserve: '0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c',
    token: 'USDT',
    chainId: 677,
    watchers: ['api', 'logs', 'gas'], // 3 Watcher'а
  },
  'x-layer': {
    rpc: 'https://rpc.xlayer.tech',
    insurance: '0x8D10C2c6C92b613C1938fe532f0e391044e76188',
    reserve: '0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c',
    token: 'USDC',
    chainId: 196,
    watchers: ['api', 'logs', 'gas', 'okx', 'rpc'], // 5 Watcher'ов
  },
};
