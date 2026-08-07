import { createPublicClient, http, Chain } from "viem";

/**
 * BOT Chain (Chain ID 677) - Mainnet for Zeus Insurance
 */
export const botChain: Chain = {
  id: 677,
  name: "BOT Chain",
  network: "bot-chain",
  nativeCurrency: {
    decimals: 18,
    name: "BOT",
    symbol: "BOT",
  },
  rpcUrls: {
    default: { http: ["https://rpc.botchain.ai"] },
    public: { http: ["https://rpc.botchain.ai"] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: "https://scan.botchain.ai" },
  },
};

/**
 * X Layer (Chain ID 196) - OKX's Ethereum L2
 */
export const xLayer: Chain = {
  id: 196,
  name: "X Layer",
  network: "x-layer",
  nativeCurrency: {
    decimals: 18,
    name: "OKB",
    symbol: "OKB",
  },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech"] },
    public: { http: ["https://rpc.xlayer.tech"] },
  },
  blockExplorers: {
    default: { name: "X Layer Explorer", url: "https://www.okx.com/web3/explorer/xlayer" },
  },
};

/**
 * Multichain public clients for Zeus Insurance BOT
 * - BOT Chain (677): Mainnet
 * - X Layer (196): Secondary chain
 */
export const publicClients = {
  botChain: createPublicClient({
    chain: botChain,
    transport: http(),
  }),
  xLayer: createPublicClient({
    chain: xLayer,
    transport: http(),
  }),
};

/**
 * Get public client for a specific chain ID
 */
export function getPublicClient(chainId: number) {
  switch (chainId) {
    case 677:
      return publicClients.botChain;
    case 196:
      return publicClients.xLayer;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/**
 * Default client (BOT Chain) for backward compatibility
 */
export const publicClient = publicClients.botChain;

export const getClient = getPublicClient;
