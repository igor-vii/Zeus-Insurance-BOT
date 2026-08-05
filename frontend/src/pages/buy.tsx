import { useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { toast } from "@/components/ui/use-toast"; // ваш импорт тостов
import { useZeusSDK } from "@/hooks/useZeusSDK";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { parseEther, formatEther } from "viem";

// ============ КОНФИГУРАЦИЯ ============
const SUPPORTED_CHAIN_IDS = new Set([
  196,   // X Layer Mainnet
  1456,  // BOT Chain Mainnet
]);

// ============ СХЕМА ФОРМЫ ============
const formSchema = z.object({
  sellerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address"),
  amount: z.string().min(1, "Amount required"),
  timeoutSeconds: z.coerce.number().min(60, "Minimum 60 seconds"),
  retries: z.coerce.number().min(1).max(10),
  mode: z.enum(["direct", "api"]),
});

type FormValues = z.infer<typeof formSchema>;

// ============ API CLIENT ============
async function fetchPrepareBuy(params: {
  seller: string;
  amount: string;
  timeoutSeconds: number;
  maxRetries: number;
  premium: string; // ← ДОБАВЛЕНО
  chainId: number;
}) {
  const response = await fetch("/api/prepare-buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Unknown error" }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

// ============ КОМПОНЕНТ ============
export function BuyInsurance() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { sdk, isSdkReady, sdkError, reconnect } = useZeusSDK();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sellerAddress: "",
      amount: "",
      timeoutSeconds: 3600,
      retries: 3,
      mode: "direct",
    },
  });

  // ============ РАСЧЁТ PREMIUM ============
  /**
   * Рассчитывает premium на основе amount.
   * Замените логику на вашу реальную формулу или вызов API pricing.
   */
  const calculatePremium = (amountWei: bigint): bigint => {
    // Пример: premium = amount * 2.5% = amount * 25 / 1000
    // Замените на реальную логику из pricing.ts
    return (amountWei * 25n) / 1000n;
  };

  // ============ ОБРАБОТКА ОТПРАВКИ ============
  async function onSubmit(values: FormValues) {
    // 1. Проверка подключения
    if (!isConnected) {
      toast({
        variant: "destructive",
        title: "Wallet not connected",
        description: "Please connect your wallet first.",
      });
      return;
    }

    // 2. Проверка готовности SDK
    if (!isSdkReady || !sdk) {
      toast({
        variant: "destructive",
        title: "SDK not ready",
        description: sdkError || "Wallet connection still initialising, please wait.",
      });
      // Пробуем переподключиться автоматически
      reconnect();
      return;
    }

    // 3. 🔒 ПРОВЕРКА СЕТИ (НОВОЕ)
    if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
      toast({
        variant: "destructive",
        title: "Wrong Network",
        description: `Current chain (${chainId}) is not supported. Please switch to X Layer (196) or BOT Chain.`,
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const amountBigInt = parseEther(values.amount);
      const premiumAmount = calculatePremium(amountBigInt);

      console.log("[BuyInsurance] Submitting with params:", {
        seller: values.sellerAddress,
        amount: amountBigInt.toString(),
        premium: premiumAmount.toString(),
        timeoutSeconds: values.timeoutSeconds,
        maxRetries: values.retries,
        mode: values.mode,
        chainId,
      });

      if (values.mode === "api") {
        // ============ API MODE (для ИИ-агентов) ============
        const result = await fetchPrepareBuy({
          seller: values.sellerAddress,
          amount: amountBigInt.toString(),
          timeoutSeconds: values.timeoutSeconds,
          maxRetries: values.retries,
          premium: premiumAmount.toString(), // ← ДОБАВЛЕНО
          chainId,
        });

        toast({
          title: "API Policy Created",
          description: `Policy prepared via API. Tx: ${result.txHash || "pending"}`,
        });
      } else {
        // ============ DIRECT MODE (для ПК-браузеров) ============
        // 🔧 ИСПРАВЛЕНО: добавлен 5-й аргумент premiumAmount
        const { policyId } = await sdk.insurance.createPolicy(
          values.sellerAddress,
          amountBigInt,
          values.timeoutSeconds,
          values.retries,
          premiumAmount // ← ДОБАВЛЕНО
        );

        toast({
          title: "Policy Created",
          description: `Policy #${policyId} created successfully.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transaction failed";
      console.error("[BuyInsurance] Error:", error);

      toast({
        variant: "destructive",
        title: "Transaction Failed",
        description: message,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // ============ RENDER ============
  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      {/* Ваши поля формы */}
      <input {...form.register("sellerAddress")} placeholder="Seller Address" />
      <input {...form.register("amount")} placeholder="Amount (ETH)" />
      <input {...form.register("timeoutSeconds")} type="number" />
      <input {...form.register("retries")} type="number" />
      
      <select {...form.register("mode")}>
        <option value="direct">Direct (Browser)</option>
        <option value="api">API (AI Agent)</option>
      </select>

      <button type="submit" disabled={isSubmitting || !isSdkReady}>
        {isSubmitting ? "Processing..." : "Buy Insurance"}
      </button>

      {sdkError && (
        <div className="text-red-500 text-sm mt-2">
          SDK Error: {sdkError}
          <button type="button" onClick={reconnect} className="ml-2 underline">
            Retry
          </button>
        </div>
      )}
    </form>
  );
}
