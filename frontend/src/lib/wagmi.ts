import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

/**
 * WalletConnect v2 requires a projectId from https://cloud.walletconnect.com
 * Set VITE_WALLETCONNECT_PROJECT_ID in your .env to enable it.
 * Without it, Injected + Coinbase Wallet still work fine.
 */
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: "Zeus Insurance", appLogoUrl: "/favicon.svg" }),
  ...(wcProjectId
    ? [walletConnect({ projectId: wcProjectId, metadata: {
        name: "Zeus Insurance",
        description: "Decentralized insurance for AI agent payments",
        url: "https://zeus-insurance-v2.netlify.app",
        icons: ["https://zeus-insurance-v2.netlify.app/favicon.svg"],
      }})]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors,
  transports: {
    // Official Base Sepolia RPC — pagination in getLogs handles the 2 000-block limit
    [baseSepolia.id]: http("https://sepolia.base.org"),
  },
});
