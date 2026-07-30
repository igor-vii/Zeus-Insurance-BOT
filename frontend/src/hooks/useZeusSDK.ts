import { useEffect, useRef, useState } from "react";
import { useWalletClient, useChainId } from "wagmi";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

/** Maps wagmi chainId to Zeus SDK network name */
function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 677:  return "bot-chain-mainnet"; // ← ИСПРАВЛЕНО
    case 196:  return "x-layer";           // ← УТОЧНИ, КАК НАЗЫВАЕТСЯ В SDK
    default:   return "bot-chain-mainnet"; // ← ИСПРАВЛЕНО
  }
}

/**
 * Provides a connected ZeusSDK instance backed by the active wagmi wallet.
 * Re-connects whenever the wallet or chain changes.
 */
export function useZeusSDK() {
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const sdkRef = useRef<ZeusSDK>(new ZeusSDK());
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const sdk = sdkRef.current;

    if (!walletClient) {
      sdk.disconnect();
      setIsReady(false);
      return;
    }

    let cancelled = false;

    const provider = new BrowserProvider(
      walletClient.transport as unknown as Eip1193Provider,
    );

    const network = chainIdToNetwork(chainId);

    provider
      .getSigner()
      .then((signer) => sdk.connect(network, signer))
      .then(() => { if (!cancelled) setIsReady(true); })
      .catch((err) => { 
        console.error("SDK connection error:", err);
        if (!cancelled) setIsReady(false); 
      });

    return () => { cancelled = true; };
  }, [walletClient, chainId]);

  return { sdk: sdkRef.current, isReady };
}
