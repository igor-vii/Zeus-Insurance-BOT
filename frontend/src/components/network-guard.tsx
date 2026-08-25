import { useAccount, useChainId, useSwitchChain, useWalletClient } from "wagmi";
import { SUPPORTED_CHAINS } from "@/lib/wagmi";
import { AlertTriangle, ArrowRightLeft, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";

const SUPPORTED_IDS = SUPPORTED_CHAINS.map((c) => c.id);

/**
 * Добавляет цепочку в кошелёк напрямую через EIP-3085.
 * Fallback, если wagmi switchChain не сработал (сеть не добавлена в кошелёк).
 */
async function addChainToWallet(chain: (typeof SUPPORTED_CHAINS)[number]): Promise<void> {
  const ethereum = (window as any).ethereum;
  if (!ethereum?.request) {
    throw new Error("Wallet does not support adding chains");
  }

  await ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: "0x" + chain.id.toString(16),
        chainName: chain.name,
        nativeCurrency: {
          name: chain.nativeCurrency?.name || "ETH",
          symbol: chain.nativeCurrency?.symbol || "ETH",
          decimals: chain.nativeCurrency?.decimals || 18,
        },
        rpcUrls: chain.rpcUrls?.default?.http || [""],
        blockExplorerUrls: chain.blockExplorers?.default?.url
          ? [chain.blockExplorers.default.url]
          : undefined,
      },
    ],
  });
}

export function NetworkGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const { toast } = useToast();
  const [addingChainId, setAddingChainId] = useState<number | null>(null);

  const isWrongNetwork =
    isConnected && chainId !== undefined && !SUPPORTED_IDS.includes(chainId as (typeof SUPPORTED_IDS)[number]);

  async function handleSwitch(targetChainId: number) {
    const targetChain = SUPPORTED_CHAINS.find((c) => c.id === targetChainId);
    if (!targetChain) return;

    try {
      // Попытка 1: стандартный switchChain через wagmi
      await switchChain({ chainId: targetChainId });
      toast({
        title: "Network Switched",
        description: `Connected to ${targetChain.name}.`,
      });
    } catch (switchErr: unknown) {
      console.warn("[NetworkGuard] switchChain failed, trying wallet_addEthereumChain...", switchErr);

      // Попытка 2: добавить цепочку вручную (EIP-3085)
      try {
        setAddingChainId(targetChainId);
        await addChainToWallet(targetChain);
        // После добавления пробуем переключиться снова
        await switchChain({ chainId: targetChainId });
        toast({
          title: "Network Added & Switched",
          description: `${targetChain.name} has been added to your wallet.`,
        });
      } catch (addErr: unknown) {
        console.error("[NetworkGuard] Failed to add/switch chain:", addErr);
        const msg = addErr instanceof Error ? addErr.message : "Unknown error";
        toast({
          variant: "destructive",
          title: "Cannot Switch Network",
          description: `Please add ${targetChain.name} manually in your wallet. Chain ID: ${targetChainId}. Error: ${msg}`,
        });
      } finally {
        setAddingChainId(null);
      }
    }
  }

  if (!isWrongNetwork) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        transition={{ duration: 0.2 }}
        className="fixed top-0 inset-x-0 z-50 px-4 pt-4 pointer-events-none"
      >
        <div className="max-w-2xl mx-auto pointer-events-auto">
          <div className="flex items-center gap-3 rounded-lg border border-destructive/60 bg-destructive/10 backdrop-blur-md px-4 py-3 shadow-lg">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-wider text-destructive mb-0.5">
                Wrong Network
              </p>
              <p className="text-sm text-foreground/90">
                Zeus Insurance requires{" "}
                <span className="font-semibold font-mono">X Layer</span> or{" "}
                <span className="font-semibold font-mono">BOT Chain</span>.
                Your wallet is on chain&nbsp;
                <span className="font-mono text-muted-foreground">{chainId}</span>.
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              {SUPPORTED_CHAINS.map((chain) => {
                const isWorking = isPending || addingChainId === chain.id;
                return (
                  <Button
                    key={chain.id}
                    size="sm"
                    variant="destructive"
                    className="font-mono text-[10px] uppercase tracking-wider h-8 gap-1.5"
                    onClick={() => handleSwitch(chain.id)}
                    disabled={isWorking}
                  >
                    {isWorking ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowRightLeft className="w-3 h-3" />
                    )}
                    {chain.id === 677 ? "BOT Chain" : "X Layer"}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
