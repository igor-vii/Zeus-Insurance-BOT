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
 * Bridges wagmi WalletClient → ethers v6 JsonRpcSigner without triggering
 * any RPC calls (eth_chainId, eth_requestAccounts, etc.).
 *
 * Key fix: pass `staticNetwork` option so ethers v6 BrowserProvider returns
 * the network immediately from memory instead of calling eth_chainId on the
 * walletClient transport — which would go through viem → HTTP RPC and hang
 * or fail on MetaMask Mobile.
 */
function walletClientToSigner(
  walletClient: WalletClient,
  chainId: number,
): JsonRpcSigner {
  const { account, chain } = walletClient;
  if (!account) throw new Error("Wallet account not available");

  // Build an ethers Network object for the static network.
  // Using Network.from() ensures the correct type for staticNetwork option.
  const staticNetwork = Network.from({
    chainId: BigInt(chainId),
    name: chain?.name ?? String(chainId),
  });

  const mobile = isMobile();

  // On mobile wallets (MetaMask Mobile, Trust Wallet, etc.) the viem
  // WalletClient transport can hang when ethers calls eth_chainId through it.
  // Use window.ethereum directly — ethers v6 BrowserProvider(window.ethereum)
  // is the exact equivalent of ethers v5 ethers.providers.Web3Provider(window.ethereum).
  // On desktop we keep walletClient from wagmi (avoids duplicate provider layers).
  let eip1193: Eip1193Provider;
  if (mobile && typeof window !== "undefined" && window.ethereum) {
    console.log("[sdk] mobile path — using window.ethereum directly", {
      userAgent: navigator.userAgent,
      chainId,
    });
    eip1193 = window.ethereum as unknown as Eip1193Provider;
  } else {
    console.log("[sdk] desktop path — using wagmi walletClient", {
      mobile,
      hasWindowEthereum: typeof window !== "undefined" && !!window.ethereum,
      chainId,
    });
    eip1193 = walletClient as unknown as Eip1193Provider;
  }

  // staticNetwork: <Network> tells ethers to skip the eth_chainId RPC call
  // entirely and return this network object from memory. Without this option,
  // ethers calls eth_chainId even when `network` is passed as the 2nd arg.
  const provider = new BrowserProvider(eip1193, staticNetwork, { staticNetwork });

  return new JsonRpcSigner(provider, account.address);
}

/**
 * Provides a connected ZeusSDK instance backed by the active wagmi wallet.
 * Re-connects whenever the wallet or chain changes.
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

    // Prefer the chain ID from the walletClient (the actual connected chain)
    // over the wagmi hook value, which may lag slightly on chain switch.
    const effectiveChainId = walletClient.chain?.id ?? chainId;

    if (!SUPPORTED_CHAIN_IDS.has(effectiveChainId)) {
      sdk.disconnect();
      setIsReady(false);
      setSdkError(
        `Unsupported network (chain ID ${effectiveChainId}). ` +
        `Please switch your wallet to BOT Chain (677) or X Layer (196).`
      );
      return;
    }

    let cancelled = false;
    setSdkError(null);

    const network = chainIdToNetwork(effectiveChainId);

    let signer: JsonRpcSigner;
    try {
      signer = walletClientToSigner(walletClient, effectiveChainId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create signer";
      console.error("[sdk] Signer creation error:", err);
      if (!cancelled) {
        setSdkError(msg);
        setIsReady(false);
      }
      return;
    }

    sdk.connect(network, signer)
      .then(() => {
        if (!cancelled) {
          setIsReady(true);
          setSdkError(null);
        }
      })
      .catch((err: unknown) => {
        console.error("[sdk] Connection error:", err);
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
