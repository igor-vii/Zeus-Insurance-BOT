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

/** Maps wagmi chainId to Zeus SDK network name */
function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 677: return "bot-chain-mainnet";
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
 * Uses staticNetwork so ethers v6 never issues an eth_chainId RPC call,
 * which would hang on some mobile wallet transports.
 */
function buildSigner(
  eip1193: Eip1193Provider,
  address: string,
  walletClient: WalletClient,
  chainId: number,
): JsonRpcSigner {
  const staticNetwork = Network.from({
    chainId: BigInt(chainId),
    name: walletClient.chain?.name ?? String(chainId),
  });
  const provider = new BrowserProvider(eip1193, staticNetwork, { staticNetwork });
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
            walletClient!,
            effectiveChainId,
          );
          console.log("[sdk] mobile — signer built, calling sdk.connect() (5 s timeout)");
          await withTimeout(sdk.connect(network, signer), 5000, "sdk.connect via window.ethereum");
          console.log("[sdk] mobile — connected via window.ethereum ✅");
          return; // success
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[sdk] mobile — window.ethereum path failed, falling back to wagmi walletClient:", msg);
          // fall through to wagmi fallback below
        }
      } else {
        console.log("[sdk] desktop — using wagmi walletClient directly", {
          mobile,
          hasWindowEth,
        });
      }

      // ── Desktop or mobile fallback: use wagmi walletClient ─────────────────
      console.log("[sdk] attempting wagmi walletClient path");
      const signer = buildSigner(
        walletClient as unknown as Eip1193Provider,
        address!,
        walletClient!,
        effectiveChainId,
      );
      console.log("[sdk] wagmi signer built, calling sdk.connect()");
      await sdk.connect(network, signer);
      console.log("[sdk] connected via wagmi walletClient ✅");
    }

    connectWithFallback()
      .then(() => {
        if (!cancelled) {
          setIsReady(true);
          setSdkError(null);
        }
      })
      .catch((err: unknown) => {
        console.error("[sdk] connection failed ❌", err);
        if (!cancelled) {
          const msg = err instanceof Error ? err.message.split("\n")[0] : "SDK connection failed";
          setSdkError(msg);
          setIsReady(false);
        }
      });

    return () => { cancelled = true; };
  }, [walletClient, chainId]);

  return { sdk: sdkRef.current, isReady, sdkError };
}
