import { useEffect, useRef, useState } from "react";
import { useWalletClient } from "wagmi";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

/**
 * Provides a connected ZeusSDK instance backed by the active wagmi wallet.
 *
 * The SDK is kept stable across renders (useRef) and re-connected whenever
 * the wagmi WalletClient changes (account switch, network switch).
 *
 * Usage:
 *   const { sdk, isReady } = useZeusSDK();
 *   if (isReady) await sdk.insurance.createPolicy(...);
 */
export function useZeusSDK() {
  const { data: walletClient } = useWalletClient();
  // Stable SDK instance — never recreated
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

    // viem WalletClient.transport is EIP-1193 compatible — use it as the ethers provider
    const provider = new BrowserProvider(
      walletClient.transport as unknown as Eip1193Provider,
    );

    provider
      .getSigner()
      .then((signer) => sdk.connect("base-sepolia", signer))
      .then(() => { if (!cancelled) setIsReady(true); })
      .catch(() => { if (!cancelled) setIsReady(false); });

    return () => { cancelled = true; };
  }, [walletClient]);

  return { sdk: sdkRef.current, isReady };
}
