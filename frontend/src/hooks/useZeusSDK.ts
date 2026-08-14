declare global {
  interface Window {
    ethereum?: import('ethers').Eip1193Provider & {
      isMetaMask?: boolean;
    };
  }
}

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { BrowserProvider, JsonRpcSigner, Network } from "ethers";
import type { Eip1193Provider } from "ethers";
import { ZeusSDK } from "@zeus/sdk"; // замените на ваш реальный импорт

// ============ КОНФИГУРАЦИЯ ============
const SDK_TIMEOUT_MS = 1000; // 1 сек вместо 5
const SUPPORTED_CHAIN_IDS = new Set([
  196,   // X Layer Mainnet
  677,  // BOT Chain Mainnet (проверьте реальный ID)
]);

// ============ ТИПЫ ============
interface SDKState {
  sdk: ZeusSDK | null;
  isSdkReady: boolean;
  sdkError: string | null;
  isLoading: boolean;
}

// ============ ОБЁРТКА ПРОВАЙДЕРА ============
/**
 * Создаёт обёрнутый Eip1193Provider, который:
 * 1. Перехватывает eth_chainId — ethers v6 не будет висеть в WebView
 * 2. Перехватывает eth_accounts — возвращает известный адрес, не доверяя провайдеру
 * 3. Проксирует всё остальное с таймаутом
 */
function createWrappedProvider(
  rawProvider: Eip1193Provider,
  knownAddress: string,
  knownChainId: number
): Eip1193Provider {
  const requestWithTimeout = async <T>(
    request: { method: string; params?: unknown[] },
    timeoutMs: number = 5000
  ): Promise<T> => {
    return Promise.race([
      rawProvider.request(request),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Provider timeout: ${request.method}`)), timeoutMs)
      ),
    ]);
  };

  return {
    request: async (request) => {
      const { method } = request;

      // 🔒 Перехват eth_chainId — ethers v6 иногда шлёт это на старте
      if (method === "eth_chainId") {
        console.log("[ZeusSDK] Intercepted eth_chainId, returning known value");
        return "0x" + knownChainId.toString(16);
      }

      // 🔒 Перехват eth_accounts — не доверяем WebView-провайдеру
      if (method === "eth_accounts") {
        console.log("[ZeusSDK] Intercepted eth_accounts, returning known address");
        return [knownAddress];
      }

      // Проксируем остальное с таймаутом
      return requestWithTimeout(request);
    },
  };
}

// ============ BUILD SIGNER ============
function buildSigner(
  eip1193: Eip1193Provider,
  address: string,
  chainId: number
): JsonRpcSigner {
  const staticNetwork = Network.from(chainId);
  const wrapped = createWrappedProvider(eip1193, address, chainId);

  const provider = new BrowserProvider(wrapped, staticNetwork, {
    staticNetwork,
    name: "zeus-static",
  });

  return new JsonRpcSigner(provider, address);
}

// ============ DETECT MOBILE ============
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Проверяем userAgent вместо/вместе с window.innerWidth
    const checkMobile = () => {
      const ua = navigator.userAgent.toLowerCase();
      const isMobileUA =
        /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|trust|tokenpocket|metamask/i.test(
          ua
        );
      const isMobileWidth = window.innerWidth < 768;
      setIsMobile(isMobileUA || isMobileWidth);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return isMobile;
}

// ============ HOOK ============
export function useZeusSDK(): SDKState & { reconnect: () => void } {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const isMobile = useIsMobile();

  const [state, setState] = useState<SDKState>({
    sdk: null,
    isSdkReady: false,
    sdkError: null,
    isLoading: false,
  });

  const connectSdk = useCallback(async () => {
    if (!isConnected || !address || !chainId) {
      setState({ sdk: null, isSdkReady: false, sdkError: null, isLoading: false });
      return;
    }

    // Проверяем, что сеть поддерживается
    if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
      setState({
        sdk: null,
        isSdkReady: false,
        sdkError: `Unsupported chain: ${chainId}. Please switch to X Layer or BOT Chain.`,
        isLoading: false,
      });
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, sdkError: null }));

    try {
      console.log("[ZeusSDK] Starting connection...", {
        address,
        chainId,
        isMobile,
        hasWindowEth: typeof window !== "undefined" && !!window.ethereum,
        hasWalletClient: !!walletClient,
      });

      let signer: JsonRpcSigner | null = null;
      let connectionMethod = "";

      // ============ ПУТЬ 1: wagmi walletClient (предпочтительный для всех) ============
      if (walletClient) {
        try {
          console.log("[ZeusSDK] Trying walletClient path...");
          const transport = walletClient.transport;

          // Создаём Eip1193Provider из wagmi walletClient
          const eip1193Provider: Eip1193Provider = {
            request: async (request) => {
              return transport.request(request);
            },
          };

          signer = buildSigner(eip1193Provider, address, chainId);
          connectionMethod = "walletClient";
          console.log("[ZeusSDK] walletClient path succeeded");
        } catch (walletClientErr) {
          console.warn("[ZeusSDK] walletClient path failed:", walletClientErr);
          // Не падаем — пробуем следующий путь
        }
      }

      // ============ ПУТЬ 2: window.ethereum (только для desktop, с обёрткой) ============
      if (!signer && typeof window !== "undefined" && window.ethereum && !isMobile) {
        try {
          console.log("[ZeusSDK] Trying window.ethereum path (desktop only)...");
          signer = buildSigner(
            window.ethereum as unknown as Eip1193Provider,
            address,
            chainId
          );
          connectionMethod = "window.ethereum (desktop)";
          console.log("[ZeusSDK] window.ethereum path succeeded");
        } catch (ethErr) {
          console.warn("[ZeusSDK] window.ethereum path failed:", ethErr);
        }
      }

      // ============ ПУТЬ 3: window.ethereum для мобильных (только с таймаутом и обёрткой) ============
      if (!signer && typeof window !== "undefined" && window.ethereum && isMobile) {
        try {
          console.log("[ZeusSDK] Trying wrapped window.ethereum path (mobile)...");
          signer = buildSigner(
            window.ethereum as unknown as Eip1193Provider,
            address,
            chainId
          );
          connectionMethod = "window.ethereum (mobile wrapped)";
          console.log("[ZeusSDK] wrapped window.ethereum path succeeded");
        } catch (mobileEthErr) {
          console.warn("[ZeusSDK] wrapped window.ethereum path failed:", mobileEthErr);
        }
      }

      if (!signer) {
        throw new Error(
          "No signer available. Please ensure your wallet is connected and supports the current network."
        );
      }

      // ============ ИНИЦИАЛИЗАЦИЯ SDK ============
      console.log("[ZeusSDK] Initializing SDK with signer...", { connectionMethod });
      const sdk = new ZeusSDK({ signer, chainId });
      
      // Проверочный вызов — убеждаемся, что signer работает
      const testAddress = await signer.getAddress();
      console.log("[ZeusSDK] Signer verified, address:", testAddress);

      setState({
        sdk,
        isSdkReady: true,
        sdkError: null,
        isLoading: false,
      });

      console.log("[ZeusSDK] SDK ready via", connectionMethod);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown SDK initialization error";
      console.error("[ZeusSDK] Connection failed:", errorMessage);

      setState({
        sdk: null,
        isSdkReady: false,
        sdkError: errorMessage,
        isLoading: false,
      });
    }
  }, [isConnected, address, chainId, walletClient, isMobile]);

  // Автоподключение при изменении зависимостей
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      connectSdk();
    }, 100); // Небольшая задержка для стабилизации wagmi

    return () => clearTimeout(timeoutId);
  }, [connectSdk]);

  const reconnect = useCallback(() => {
    setState({ sdk: null, isSdkReady: false, sdkError: null, isLoading: false });
    setTimeout(connectSdk, 100);
  }, [connectSdk]);

  return { ...state, reconnect };
}
