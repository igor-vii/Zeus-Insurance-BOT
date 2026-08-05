import { useEffect, useRef, useState } from "react";
import { useWalletClient, useChainId } from "wagmi";
import type { WalletClient } from "viem";
import { BrowserProvider, JsonRpcSigner, Network, type Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

const SUPPORTED_CHAIN_IDS = new Set([677, 196]);

function isMobile(): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 677: return "bot-chain-mainnet";
    case 196: return "x-layer";
    default: return "bot-chain-mainnet";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function buildSigner(
  eip1193: Eip1193Provider,
  address: string,
  chainId: number,
): JsonRpcSigner {
  const staticNetwork = Network.from(chainId);
  
  const wrapped: Eip1193Provider = {
    request: async (request) => {
      if (request.method === 'eth_chainId') {
        return '0x' + chainId.toString(16);
      }
      if (request.method === 'eth_accounts') {
        return [address];
      }
      return eip1193.request(request);
    }
  };
  
  const provider = new BrowserProvider(wrapped, staticNetwork, { staticNetwork });
  return new JsonRpcSigner(provider, address);
}

export function useZeusSDK() {
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const sdkRef = useRef<ZeusSDK>(new ZeusSDK());
  const [isReady, setIsReady] = useState(false);
  const [sdkError, setSdkError] = useState<string | null>(null);

  useEffect(() => {
    const sdk = sdkRef.current;
    sdk.debug = true;

    if (!walletClient) {
      sdk.disconnect();
      setIsReady(false);
      setSdkError(null);
      return;
    }

    const effectiveChainId = walletClient.chain?.id ?? chainId;
    const address = walletClient.account?.address;

    if (!address) {
      setSdkError("Wallet account not available");
      setIsReady(false);
      return;
    }

    if (!SUPPORTED_CHAIN_IDS.has(effectiveChainId)) {
      sdk.disconnect();
      setIsReady(false);
      setSdkError(`Unsupported network (chain ID ${effectiveChainId}). Please switch to BOT Chain (677) or X Layer (196).`);
      return;
    }

    let cancelled = false;
    setSdkError(null);

    const network = chainIdToNetwork(effectiveChainId);
    const mobile = isMobile();
    const hasWindowEth = typeof window !== "undefined" && !!window.ethereum;

    async function connectWithFallback() {
      if (mobile && hasWindowEth) {
        console.log("[sdk] mobile — attempting window.ethereum path");
        try {
          const signer = buildSigner(
            window.ethereum as unknown as Eip1193Provider,
            address!,
            effectiveChainId,
          );
          try {
            await withTimeout(sdk.connect(network, signer), 1000, "sdk.connect via window.ethereum");
            console.log("[sdk] mobile — connected via window.ethereum ✅");
            return;
          } catch (connectErr) {
            const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
            console.warn("[sdk] mobile — sdk.connect() via window.ethereum failed:", msg);
          }
        } catch (signerErr) {
          const msg = signerErr instanceof Error ? signerErr.message : String(signerErr);
          console.warn("[sdk] mobile — buildSigner(window.ethereum) failed:", msg);
        }
        console.log("[sdk] mobile — falling back to wagmi walletClient");
      }

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
        throw new Error(msg);
      }

      try {
        await sdk.connect(network, signer);
        console.log("[sdk] connected via wagmi walletClient ✅");
      } catch (connectErr) {
        const msg = connectErr instanceof Error ? connectErr.message.split("\n")[0] : "sdk.connect() failed";
        console.error("[sdk] sdk.connect() via wagmi walletClient failed:", msg);
        throw new Error(msg);
      }
    }

    connectWithFallback()
      .then(() => {
        if (!cancelled) {
          setIsReady(true);
          setSdkError(null);
        }
      })
      .catch((err: unknown) => {
        console.error("[sdk] all connection paths failed ❌", err);
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
