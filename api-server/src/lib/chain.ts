import { createPublicClient, http, Chain } from "viem";

/**
 * BOT Chain (Chain ID 677) - Mainnet for Zeus Insurance
 */
export const botChain: Chain = {
  id: 677,
  name: "BOT Chain",
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
 * Base Sepolia (Chain ID 84532) - Testnet
 */
export const baseSepolia: Chain = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
    public: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://sepolia.basescan.org" },
  },
};

/**
 * Multichain public clients for Zeus Insurance BOT
 * - BOT Chain (677): Mainnet
 * - X Layer (196): Primary mainnet (canonical insurance/reserve/escrow generation)
 * - Base Sepolia (84532): Testnet
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
  baseSepolia: createPublicClient({
    chain: baseSepolia,
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
    case 84532:
      return publicClients.baseSepolia;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/**
 * Default client (BOT Chain) for backward compatibility
 */
export const publicClient = publicClients.botChain;

export const getClient = getPublicClient;
