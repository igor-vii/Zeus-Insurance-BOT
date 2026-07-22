import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useAccount, useWaitForTransactionReceipt, useSendTransaction,
} from "wagmi";
import { isAddress } from "viem";
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

const isEthAddress = (val: string): boolean => isAddress(val);

const formSchema = z.object({
  sellerAddress: z.string().refine(isEthAddress, { message: "Invalid Ethereum address" }),
  amount: z.coerce.number().min(1, "Amount must be at least 1 USDC"),
  timeoutSeconds: z.coerce.number().min(60, "Timeout must be at least 60 seconds"),
  retries: z.coerce.number().min(1).max(10),
});

export default function BuyInsurance() {
  const { address, isConnected } = useAccount();
  const { toast } = useToast();
  const { isApiMode } = useApiMode();
  const { sdk, isReady: isSdkReady } = useZeusSDK();

  const [premiumBps, setPremiumBps] = useState(700n);
  const [premiumAmount, setPremiumAmount] = useState(0n);
  const [amountBigInt, setAmountBigInt] = useState(0n);
  const [apiError, setApiError] = useState<string | null>(null);

  // Direct mode — SDK handles both USDC approval and buyInsurance in one call
  const [isBuyingSdk, setIsBuyingSdk] = useState(false);

  // API mode — server-prepared calldata
  const { sendTransactionAsync, isPending: isBuyingApi } = useSendTransaction();
  const [apiBuyHash, setApiBuyHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isWaitingApiBuy, isSuccess: isApiBuySuccess } = useWaitForTransactionReceipt({ hash: apiBuyHash });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { sellerAddress: "", amount: 100, timeoutSeconds: 86400, retries: 1 },
  });

  const watchAmount = form.watch("amount");
  const watchRetries = form.watch("retries");

  // Premium preview — computed locally (same formula as contract)
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

  useEffect(() => {
    if (isApiBuySuccess) {
      toast({ title: "Policy Created!", description: "Your insurance policy is now active." });
      form.reset({ ...form.getValues(), sellerAddress: "" });
      setApiError(null);
    }
  }, [isApiBuySuccess, form, toast]);

  const isBuying = isApiMode ? isBuyingApi : isBuyingSdk;
  const isWaiting = isApiMode ? isWaitingApiBuy : false; // SDK awaits receipt internally
  const totalCost = amountBigInt > 0 ? premiumAmount : 0n;

  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (!isConnected) {
      toast({ variant: "destructive", title: "Wallet not connected", description: "Please connect your wallet first." });
      return;
    }
    setApiError(null);

    if (isApiMode) {
      // API mode: server builds calldata, user signs raw tx
      try {
        const result = await fetchPrepareBuy({
          seller: values.sellerAddress,
          amount: amountBigInt.toString(),
          timeoutSeconds: values.timeoutSeconds,
          maxRetries: values.retries,
        });
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
      // Direct mode: SDK handles USDC approval + buyInsurance in one call
      if (!isSdkReady) {
        toast({ variant: "destructive", title: "SDK not ready", description: "Wallet connection still initialising, please wait." });
        return;
      }
      setIsBuyingSdk(true);
      try {
        const { policyId } = await sdk.insurance.createPolicy(
          values.sellerAddress,
          amountBigInt,
          values.timeoutSeconds,
          values.retries,
        );
        toast({ title: "Policy Created!", description: `Policy #${policyId} is now active.` });
        form.reset({ ...form.getValues(), sellerAddress: "" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message.split("\n")[0] : "Unknown error";
        toast({ variant: "destructive", title: "Purchase Failed", description: msg });
      } finally {
        setIsBuyingSdk(false);
      }
    }
  }

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
          {isApiMode && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Calldata via API · signed locally
            </span>
          )}
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
                      <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">Insured Amount (USDC)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" className="font-mono bg-background/50" {...field} />
                      </FormControl>
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
                  <span className="font-mono text-sm">${watchAmount || 0} USDC</span>
                </div>
                <div className="w-full h-px bg-primary/20 my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-mono text-sm uppercase tracking-wider text-primary font-bold">Total Cost</span>
                  <span className="font-mono text-xl font-bold">${formatUsdc(totalCost)} USDC</span>
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
