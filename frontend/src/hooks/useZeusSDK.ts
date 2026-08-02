import { useEffect, useRef, useState } from "react";
import { useWalletClient, useChainId } from "wagmi";
import type { WalletClient } from "viem";
import { BrowserProvider, JsonRpcSigner, type Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

/** Maps wagmi chainId to Zeus SDK network name */
function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 677: return "bot-chain-mainnet";
    case 196:  return "x-layer";
    default:   return "bot-chain-mainnet";
  }
}

/**
 * Bridges wagmi WalletClient → ethers v6 JsonRpcSigner without triggering
 * eth_requestAccounts or eth_chainId.
 *
 * On MetaMask Mobile the injected provider serialises `eth_requestAccounts`
 * calls and may reject a second one that comes from ethers' getSigner().
 * Passing chain info explicitly and constructing JsonRpcSigner directly
 * avoids both extra RPC round-trips and resolves mobile compatibility.
 */
function walletClientToSigner(
  walletClient: WalletClient,
  chainId: number,
): JsonRpcSigner {
  const { account, chain, transport } = walletClient;
  if (!account) throw new Error("Wallet account not available");
  const network = {
    chainId,
    name: chain?.name ?? String(chainId),
  };
  const provider = new BrowserProvider(transport as unknown as Eip1193Provider, network);
  return new JsonRpcSigner(provider, account.address);
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
    const network = chainIdToNetwork(chainId);

    const signer = walletClientToSigner(walletClient, chainId);

    sdk.connect(network, signer)
      .then(() => { if (!cancelled) setIsReady(true); })
      .catch((err) => {
        console.error("SDK connection error:", err);
        if (!cancelled) setIsReady(false);
      });

    return () => { cancelled = true; };
  }, [walletClient, chainId]);

  return { sdk: sdkRef.current, isReady };
}
