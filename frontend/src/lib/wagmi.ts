import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

// ─── Supported chains ─────────────────────────────────────────────────────────

export const xLayerMainnet = defineChain({
  id: 196,
  name: "X Layer Mainnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech"] },
    public:  { http: ["https://rpc.xlayer.tech"] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/xlayer" },
  },
});

export const botChainMainnet = defineChain({
  id: 677,
  name: "BOT Chain Mainnet",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.botchain.ai"] },
    public:  { http: ["https://rpc.botchain.ai"] },
  },
  blockExplorers: {
    default: { name: "BOT Explorer", url: "https://scan.botchain.ai" },
  },
});

export const SUPPORTED_CHAINS = [xLayerMainnet, botChainMainnet] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]["id"];

// ─── Connectors ───────────────────────────────────────────────────────────────

/**
 * WalletConnect v2 requires a projectId from https://cloud.walletconnect.com
 * Set VITE_WALLETCONNECT_PROJECT_ID in your .env to enable it.
 */
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: "Zeus Insurance", appLogoUrl: "/favicon.svg" }),
  ...(wcProjectId
    ? [walletConnect({
        projectId: wcProjectId,
        metadata: {
          name: "Zeus Insurance",
          description: "Decentralized insurance for AI agents",
          url: "https://zeus-insurance-bot.netlify.app",
          icons: ["https://zeus-insurance-bot.netlify.app/favicon.svg"],
        },
      })]
    : []),
];

// ─── Config ───────────────────────────────────────────────────────────────────

export const wagmiConfig = createConfig({
  chains: [xLayerMainnet, botChainMainnet],
  connectors,
  transports: {
    [xLayerMainnet.id]:    http("https://rpc.xlayer.tech"),
    [botChainMainnet.id]:  http("https://rpc.botchain.ai"),
  },
});
