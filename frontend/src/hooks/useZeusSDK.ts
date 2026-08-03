import { useEffect, useRef, useState } from "react";
import { useWalletClient, useChainId } from "wagmi";
import type { WalletClient } from "viem";
import { BrowserProvider, JsonRpcSigner, Network, type Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

const SUPPORTED_CHAIN_IDS = new Set([677, 196]);

/** Returns true when running inside a mobile browser / in-app wallet browser. */
function isMobile(): boolean {
  return /Mobi|Android|iPhone/i.test(navigator.userAgent);
}

/**
 * Maps wagmi chainId to Zeus SDK network name.
 *   677 → "bot-chain-mainnet"  (BOT Chain / Botanix)
 *   196 → "x-layer"            (X Layer / OKX L2)
 */
function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 677: return "bot-chain-mainnet"; // ✅ BOT Chain mainnet
    case 196:  return "x-layer";
    default:   return "bot-chain-mainnet";
  }
}

/**
 * Races `promise` against a timeout. Rejects with a TimeoutError if `ms`
 * elapses first so the caller can catch and fall back.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[sdk] timeout after ${ms}ms: ${label}`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Builds a JsonRpcSigner from an EIP-1193 provider.
 *
 * Second arg to BrowserProvider is the raw chain ID number (677 for BOT
 * mainnet, 196 for X Layer) — ethers v6 accepts Networkish (number | string |
 * Network) so we skip building a Network object for that arg.
 *
 * The third-arg `staticNetwork` option still requires a Network instance;
 * Network.from(chainId) builds it cheaply from the number so ethers never
 * issues an eth_chainId RPC call (which hangs on some mobile wallet transports).
 */
function buildSigner(
  eip1193: Eip1193Provider,
  address: string,
  chainId: number, // plain number: 677 = BOT mainnet, 196 = X Layer
): JsonRpcSigner {
  const staticNetwork = Network.from(chainId); // Network object required for the option
  const provider = new BrowserProvider(eip1193, chainId, { staticNetwork });
  return new JsonRpcSigner(provider, address);
}

/**
 * Provides a connected ZeusSDK instance backed by the active wagmi wallet.
 * Re-connects whenever the wallet or chain changes.
 *
 * Mobile strategy:
 *   1. Try window.ethereum directly (avoids viem transport hanging).
 *   2. If that times out (5 s) or fails → fall back to wagmi walletClient.
 *
 * Desktop: always uses wagmi walletClient.
 *
 * Returns:
 *  - sdk       — the ZeusSDK instance (stable ref)
 *  - isReady   — true once sdk.connect() has resolved successfully
 *  - sdkError  — human-readable error string if connect failed, else null
 */
export function useZeusSDK() {
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const sdkRef = useRef<ZeusSDK>(new ZeusSDK());
  const [isReady, setIsReady] = useState(false);
  const [sdkError, setSdkError] = useState<string | null>(null);

  useEffect(() => {
    const sdk = sdkRef.current;

    if (!walletClient) {
      sdk.disconnect();
      setIsReady(false);
      setSdkError(null);
      return;
    }

    const effectiveChainId = walletClient.chain?.id ?? chainId;
    const address = walletClient.account?.address;

    console.log("[sdk] useEffect triggered", {
      address,
      effectiveChainId,
      mobile: isMobile(),
      hasWindowEthereum: typeof window !== "undefined" && !!window.ethereum,
    });

    if (!address) {
      setSdkError("Wallet account not available");
      setIsReady(false);
      return;
    }

    if (!SUPPORTED_CHAIN_IDS.has(effectiveChainId)) {
      sdk.disconnect();
      setIsReady(false);
      setSdkError(
        `Unsupported network (chain ID ${effectiveChainId}). ` +
        `Please switch your wallet to BOT Chain (677) or X Layer (196).`,
      );
      return;
    }

    let cancelled = false;
    setSdkError(null);

    const network = chainIdToNetwork(effectiveChainId);
    const mobile  = isMobile();
    const hasWindowEth = typeof window !== "undefined" && !!window.ethereum;

    async function connectWithFallback() {
      // ── Mobile: try window.ethereum first, fallback to wagmi ──────────────
      if (mobile && hasWindowEth) {
        console.log("[sdk] mobile — attempting window.ethereum path");
        try {
          const signer = buildSigner(
            window.ethereum as unknown as Eip1193Provider,
            address!,
            effectiveChainId,
          );
          console.log("[sdk] mobile — signer built, calling sdk.connect() (5 s timeout)");
          try {
            await withTimeout(sdk.connect(network, signer), 5000, "sdk.connect via window.ethereum");
            console.log("[sdk] mobile — connected via window.ethereum ✅");
            return; // success — do not fall through
          } catch (connectErr) {
            // sdk.connect() itself threw or timed out → log and fall through to wagmi
            const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
            console.warn("[sdk] mobile — sdk.connect() via window.ethereum failed:", msg);
            // error state will be set by wagmi path or the outer catch
          }
        } catch (signerErr) {
          const msg = signerErr instanceof Error ? signerErr.message : String(signerErr);
          console.warn("[sdk] mobile — buildSigner(window.ethereum) failed:", msg);
        }
        console.log("[sdk] mobile — falling back to wagmi walletClient");
      } else {
        console.log("[sdk] desktop — using wagmi walletClient directly", { mobile, hasWindowEth });
      }

      // ── Desktop or mobile fallback: use wagmi walletClient ─────────────────
      console.log("[sdk] attempting wagmi walletClient path");
      let signer: JsonRpcSigner;
      try {
        signer = buildSigner(
          walletClient as unknown as Eip1193Provider,
          address!,
          effectiveChainId,
        );
      } catch (signerErr) {
        const msg = signerErr instanceof Error ? signerErr.message : "Failed to build wagmi signer";
        console.error("[sdk] buildSigner(walletClient) failed:", msg);
        // Re-throw so the outer .catch() picks it up and stores it in sdkError
        throw new Error(msg);
      }

      console.log("[sdk] wagmi signer built, calling sdk.connect()");
      try {
        await sdk.connect(network, signer);
        console.log("[sdk] connected via wagmi walletClient ✅");
      } catch (connectErr) {
        const msg = connectErr instanceof Error ? connectErr.message.split("\n")[0] : "sdk.connect() failed";
        console.error("[sdk] sdk.connect() via wagmi walletClient failed:", msg);
        // Re-throw so the outer .catch() picks it up and stores it in sdkError
        throw new Error(msg);
      }
    }

    connectWithFallback()
      .then(() => {
        if (!cancelled) {
          setIsReady(true);
          // Clear any previous error on successful connect
          setSdkError(null);
        }
      })
      .catch((err: unknown) => {
        // All paths failed — store human-readable message in sdkError for UI display
        console.error("[sdk] all connection paths failed ❌", err);
        if (!cancelled) {
          const msg = err instanceof Error ? err.message.split("\n")[0] : "SDK connection failed";
          setSdkError(msg);   // returned from the hook; components render this as an error banner
          setIsReady(false);
        }
      });

    return () => { cancelled = true; };
  }, [walletClient, chainId]);

  return { sdk: sdkRef.current, isReady, sdkError };
}
