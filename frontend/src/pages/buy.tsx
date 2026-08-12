import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useAccount, useWaitForTransactionReceipt, useSendTransaction, useChainId,
} from "wagmi";
import { isAddress, parseUnits, encodeFunctionData } from "viem";
import { Shield, ArrowRight, Loader2, AlertTriangle, ShieldCheck, ServerCrash } from "lucide-react";
import {
  formatUsdc, parseUsdc, computePremium,
} from "@/lib/contracts";
import { useApiMode } from "@/lib/api-mode";
import { fetchPrepareBuy, ApiError } from "@/lib/api-client";
import { useZeusSDK } from "@/hooks/useZeusSDK";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import API_BASE from "@/lib/api-base";
import { ethers } from "ethers";

const isEthAddress = (val: string): boolean => isAddress(val);

// 🔧 ПОДДЕРЖИВАЕМЫЕ СЕТИ
const SUPPORTED_CHAIN_IDS = [677, 196];

const formSchema = z.object({
  sellerAddress: z.string().refine(isEthAddress, { message: "Invalid Ethereum address" }),
  amount: z.coerce.number().min(0.001, "Amount must be at least 0.001 USDT"),
  timeoutSeconds: z.coerce.number().min(60, "Timeout must be at least 60 seconds"),
  retries: z.coerce.number().min(1).max(10),
});

export default function BuyInsurance() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const { isApiMode } = useApiMode();
  const { sdk, isSdkReady, sdkError, reconnect } = useZeusSDK();

  const [premiumBps, setPremiumBps] = useState(700n);
  const [premiumAmount, setPremiumAmount] = useState(0n);
  const [amountBigInt, setAmountBigInt] = useState(0n);
  const [apiError, setApiError] = useState<string | null>(null);

  const [isBuyingSdk, setIsBuyingSdk] = useState(false);

  const { sendTransactionAsync, isPending: isBuyingApi } = useSendTransaction();
  const [apiBuyHash, setApiBuyHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isWaitingApiBuy, isSuccess: isApiBuySuccess } = useWaitForTransactionReceipt({ hash: apiBuyHash });


  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { sellerAddress: "", amount: 0.001, timeoutSeconds: 86400, retries: 1 },
  });

  const watchAmount = form.watch("amount");
  const watchRetries = form.watch("retries");

  // ─── Лейбл сети ─────────────────────────────────────────────────────────────
  const networkLabel = chainId === 677 ? "BOT Chain mainnet" : chainId === 196 ? "X Layer mainnet" : "Unknown";

  // ─── Расчёт премии ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (watchAmount > 0 && watchRetries > 0) {
      try {
        const amt = parseUsdc(watchAmount.toString());
        setAmountBigInt(amt);
        setPremiumAmount(computePremium(amt, watchRetries));
        setPremiumBps(BigInt(700 + (watchRetries - 1) * 200));
      } catch {
        setAmountBigInt(0n);
        setPremiumAmount(0n);
      }
    }
  }, [watchAmount, watchRetries]);

  // ─── Обработка успешной покупки в API mode ────────────────────────────────
  useEffect(() => {
    if (isApiBuySuccess) {
      toast({ title: "Policy Created!", description: "Your insurance policy is now active." });
      form.reset({ ...form.getValues(), sellerAddress: "" });
      setApiError(null);
    }
  }, [isApiBuySuccess, form, toast]);

  const isBuying = isApiMode ? isBuyingApi : isBuyingSdk;
  const isWaiting = isApiMode ? isWaitingApiBuy : false;
  const totalCost = amountBigInt > 0 ? premiumAmount : 0n;


// Helper function to wait for transaction confirmation
const waitForTransaction = async (hash: string, maxAttempts = 60): Promise<void> => {
  const rpcUrl = chainId === 677 ? 'https://rpc.botchain.ai' : 'https://rpc.xlayer.tech';
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getTransactionReceipt',
          params: [hash],
          id: 1
        })
      });
      const data = await response.json();
      if (data.result && data.result.status) {
        console.log('[Buy] Transaction confirmed:', hash);
        return;
      }
    } catch (err) {
      console.warn('[Buy] Polling attempt', i + 1, 'failed:', err);
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
  }
  console.warn('[Buy] Transaction not confirmed after', maxAttempts, 'attempts');
};

  // ─── Отправка формы ────────────────────────────────────────────────────────
  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      // 🔧 DEBUG: Начало onSubmit
      console.log('[Buy] onSubmit called');
      console.log('[Buy] isConnected:', isConnected);
      console.log('[Buy] chainId:', chainId);
      console.log('[Buy] isApiMode:', isApiMode);
      console.log('[Buy] API_BASE:', API_BASE);
      console.log('[Buy] values:', values);

      if (!isConnected) {
        toast({ variant: "destructive", title: "Wallet not connected", description: "Please connect your wallet first." });
        return;
      }

      // 🔧 ПРОВЕРКА СЕТИ
      if (!SUPPORTED_CHAIN_IDS.includes(chainId)) {
        toast({
          variant: "destructive",
          title: "Wrong Network",
          description: `Please switch to BOT Chain (677) or X Layer (196). Current network: ${chainId}`,
        });
        return;
      }

      setApiError(null);

      if (isApiMode) {
        // ─── API MODE ───────────────────────────────────────────────────────────
        try {
          console.log('[Buy] About to call fetchPrepareBuy');
          const result = await fetchPrepareBuy({
            seller: values.sellerAddress,
            amount: amountBigInt.toString(),
            timeoutSeconds: values.timeoutSeconds,
            maxRetries: values.retries,
            premium: premiumAmount.toString(),
            chainId,
          });
          console.log('[Buy] fetchPrepareBuy result:', result);

          // 🔧 ШАГ 1: Approve USDT
          console.log('[Buy] About to approve');
          const USDT_ADDRESS = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C' as const;
          const erc20Abi = [{
            name: 'approve',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ],
            outputs: [{ name: '', type: 'bool' }]
          }] as const;

          const approveData = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [result.to as `0x${string}`, BigInt(result.premiumAmount)],
          });

          const approveHash = await sendTransactionAsync({
            to: USDT_ADDRESS,
            data: approveData,
          });
          
          console.log('[Buy] Approve tx sent:', approveHash);
          await waitForTransaction(approveHash);
          console.log('[Buy] Approve confirmed');

          // 🔧 ШАГ 2: Buy policy
          console.log('[Buy] About to send buy tx');
          const hash = await sendTransactionAsync({ to: result.to, data: result.data });
          setApiBuyHash(hash);
        } catch (e: unknown) {
          if (e instanceof ApiError) {
            setApiError(`API error ${e.status}: ${e.message}`);
            toast({ variant: "destructive", title: "API Error", description: e.message });
          } else {
            const msg = e instanceof Error ? e.message.split("\n")[0] : "Unknown error";
            toast({ variant: "destructive", title: "Purchase Failed", description: msg });
          }
        }
      } else {
        // ─── DIRECT MODE ──────────────────────────────────────────────────────
        console.log('[Buy-DIRECT] Using SDK path');
        console.log('[Buy-DIRECT] isSdkReady:', isSdkReady, 'sdk:', !!sdk, 'sdk.insurance:', !!(sdk && (sdk as any).insurance));
        
        if (!isSdkReady && !sdk) {
          console.warn('[Buy-DIRECT] SDK not ready (no sdk object), showing toast');
          toast({ variant: "destructive", title: "SDK not ready", description: "Wallet connection still initialising, please wait." });
          return;
        }
        
        console.log('[Buy-DIRECT] Calling setIsBuyingSdk(true)');
        if (typeof setIsBuyingSdk !== 'function') {
          console.error('[Buy-DIRECT] setIsBuyingSdk is not a function!');
          toast({ variant: "destructive", title: "Internal Error", description: "State setter missing" });
          return;
        }
        
        setIsBuyingSdk(true);
        console.log('[Buy-DIRECT] Entering try block');
        
        try {
          console.log('[Buy-DIRECT] 🔥 ENTERING TRY BLOCK');
          
          // 🔧 ШАГ 1: Approve USDT
          console.log('[Buy-DIRECT] About to approve USDT');
          const USDT_ADDRESS = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C' as const;
          const erc20Abi = [{
            name: 'approve',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ],
            outputs: [{ name: '', type: 'bool' }]
          }] as const;
          
          const insuranceAddress = (sdk as any).getInsuranceAddress 
            ? (sdk as any).getInsuranceAddress(chainId) 
            : '0x2E592BEBbcC38FC3976125CB2E11312068670C45';
          
          console.log('[Buy-DIRECT] Approve params:', {
            to: USDT_ADDRESS,
            spender: insuranceAddress,
            amount: premiumAmount,
            chainId
          });
          
          const approveData = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [insuranceAddress as `0x${string}`, BigInt(premiumAmount)],
          });
          
          console.log('[Buy-DIRECT] Calling sendTransactionAsync for approve...');
          const approvePromise = sendTransactionAsync({
            to: USDT_ADDRESS,
            data: approveData,
          });
          
          const approveHash = await approvePromise;
          console.log('[Buy-DIRECT] ✅ Approve tx sent:', approveHash);
          
          console.log('[Buy-DIRECT] Waiting for approve confirmation...');
          await waitForTransaction(approveHash);
          console.log('[Buy-DIRECT] ✅ Approve confirmed');
          
          // 🔧 КРИТИЧНО: пауза 2 сек — MM Mobile теряет второй wallet-запрос
          // если отправить сразу после approve (ObjectMultiplex orphaned data bug)
          console.log('[Buy-DIRECT] ⏳ Waiting 2s for MM Mobile to stabilize...');
          await new Promise((r) => setTimeout(r, 2000));
          
          // 🔧 ФИНАЛЬНЫЙ ФИКС: создаём ethers-совместимый signer и подключаем SDK к правильной сети
          {
            console.log('[Buy-DIRECT] Creating ethers BrowserProvider signer for SDK...');
            const provider = new ethers.BrowserProvider((window as any).ethereum);
            const ethersSigner = await provider.getSigner();
            console.log('[Buy-DIRECT] ✅ ethersSigner created, address:', await ethersSigner.getAddress());
            
            const networkKey = chainId === 677 ? 'bot-chain-mainnet' : 'x-layer';
            console.log('[Buy-DIRECT] Connecting SDK to network:', networkKey);
            
            try {
              await (sdk as any).connect(networkKey, ethersSigner);
              console.log('[Buy-DIRECT] ✅ SDK connected to', networkKey);
            } catch (e: any) {
              console.error('[Buy-DIRECT] SDK connect failed:', e?.message);
              toast({ variant: "destructive", title: "SDK Error", description: e?.message || 'Failed to connect SDK' });
              throw e;
            }
          }

          // 🔧 ШАГ 2: SDK createPolicy с retry (MM Mobile иногда роняет второй запрос)
          console.log('[Buy-DIRECT] About to create policy via SDK');
          console.log('[Buy-DIRECT] SDK params:', {
            seller: values.sellerAddress,
            amount: amountBigInt,
            timeout: values.timeoutSeconds,
            retries: values.retries,
            premium: premiumAmount
          });
          
          let policyId: string | bigint | undefined;
          const MAX_RETRIES = 2;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              console.log(`[Buy-DIRECT] createPolicy attempt ${attempt}/${MAX_RETRIES}`);
              const result = await sdk.insurance.createPolicy(
                values.sellerAddress,
                amountBigInt,
                values.timeoutSeconds,
                values.retries,
                premiumAmount
              );
              policyId = result.policyId ?? result;
              console.log('[Buy-DIRECT] ✅ Policy created:', policyId);
              break;
            } catch (innerErr: any) {
              const msg = String(innerErr?.message || innerErr || '');
              console.error(`[Buy-DIRECT] createPolicy attempt ${attempt} failed:`, msg);
              // Если последняя попытка — выбрасываем наружу
              if (attempt === MAX_RETRIES) {
                // Показываем пользователю читаемое сообщение
                const userMsg = /disconnect|orphan|rejected|timeout/i.test(msg)
                  ? 'MetaMask Mobile connection dropped. Please try again (this is a known MM Mobile issue).'
                  : msg || 'Policy creation failed';
                toast({ variant: "destructive", title: "Buy failed", description: userMsg });
                throw innerErr;
              }
              // Пауза перед retry
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          
          toast({ title: "Policy Created!", description: `Policy #${policyId} is now active.` });
          form.reset({ ...form.getValues(), sellerAddress: "" });

        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : "Unknown error";
          toast({ variant: "destructive", title: "Purchase Failed", description: msg });
        } finally {
          setIsBuyingSdk(false);
        }
      }
    } catch (e) {
      console.error('[Buy] OUTER CATCH ERROR:', e);
      console.error('[Buy] Error stack:', e instanceof Error ? e.stack : 'no stack');
      toast({ variant: "destructive", title: "Fatal Error", description: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-2xl mx-auto space-y-6"
    >
      <div className="flex items-center gap-3 mb-8">
        <ShieldCheck className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-brand font-bold tracking-tight">Issue Policy</h1>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {networkLabel} · USDT
            {isApiMode && " · Calldata via API"}
          </span>
        </div>
      </div>

      {!isConnected && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">Not Connected</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">
            Connect your wallet to purchase an insurance policy.
          </AlertDescription>
        </Alert>
      )}

      {!isApiMode && isConnected && sdkError && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">Wallet Not Ready</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">{sdkError}</AlertDescription>
        </Alert>
      )}

      {apiError && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <ServerCrash className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">API Unavailable</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">
            {apiError} — try switching to Direct mode.
          </AlertDescription>
        </Alert>
      )}

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <CardHeader>
              <CardTitle className="font-mono uppercase tracking-wider text-sm">Policy Details</CardTitle>
              <CardDescription>Enter the transaction details to secure coverage.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <FormField
                control={form.control}
                name="sellerAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">Seller Address</FormLabel>
                    <FormControl>
                      <Input placeholder="0x..." className="font-mono bg-background/50" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">Insured Amount (USDT)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="0.001"
                          step="0.001"
                          className="font-mono bg-background/50"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription className="text-xs">Min: 0.001 USDT</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="timeoutSeconds"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">Timeout per retry (Sec)</FormLabel>
                      <FormControl>
                        <Input type="number" min="60" className="font-mono bg-background/50" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">Ex: 86400 = 1 day</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="retries"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground flex justify-between">
                      <span>Delivery Retries</span>
                      <span className="text-primary">{field.value}</span>
                    </FormLabel>
                    <FormControl>
                      <div className="py-2">
                        <Slider
                          min={1} max={10} step={1}
                          value={[field.value]}
                          onValueChange={(vals) => field.onChange(vals[0])}
                          className="py-2"
                        />
                      </div>
                    </FormControl>
                    <FormDescription className="text-xs">More retries = higher premium.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 mt-6">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Premium Rate</span>
                  <span className="font-mono text-sm">{Number(premiumBps) / 100}%</span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Insured Value</span>
                  <span className="font-mono text-sm">{watchAmount || 0} USDT</span>
                </div>
                <div className="w-full h-px bg-primary/20 my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-mono text-sm uppercase tracking-wider text-primary font-bold">Total Cost</span>
                  <span className="font-mono text-xl font-bold">{formatUsdc(totalCost)} USDT</span>
                </div>
              </div>
            </CardContent>

            <CardFooter>
              <Button
                type="submit"
                className="w-full font-mono uppercase tracking-wider"
                disabled={!isConnected || isBuying || isWaiting || amountBigInt === 0n}
              >
                {(isBuying || isWaiting)
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Confirming…</>
                  : <><ArrowRight className="mr-2 h-4 w-4" /> Issue Policy</>}
              </Button>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </motion.div>
  );
}


// 🔍 TEMP DIAGNOSTICS: показать скрытые async-ошибки на мобилке
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[Zeus] UNHANDLED REJECTION:", e.reason);
  });
  window.addEventListener("error", (e) => {
    console.error("[Zeus] WINDOW ERROR:", e.message);
  });
}
