import { createConfig, http } from "wagmi";
import { defineChain, fallback } from "viem"; // ← ДОБАВЛЕН fallback
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
    // 🔧 ДОБАВЛЕН fallback для надёжности
    [xLayerMainnet.id]: fallback([
      http("https://rpc.xlayer.tech"),
      http("https://xlayerrpc.okx.com"),
    ]),
    [botChainMainnet.id]: fallback([
      http("https://rpc.botchain.ai"),
    ]),
  },
});
