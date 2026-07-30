import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useAccount, useWaitForTransactionReceipt, useSendTransaction, useChainId,
} from "wagmi";
import { isAddress } from "viem";
import {
  Swords, ArrowRight, Loader2, AlertTriangle, ShieldAlert, Info,
} from "lucide-react";
import {
  formatUsdc, parseUsdc,
  computeSlashingPremium, computeSlashingPremiumBps,
  type ValidatorRisk,
} from "@/lib/contracts";
import { useZeusSDK } from "@/hooks/useZeusSDK";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const isEthAddress = (val: string): boolean => isAddress(val);

const formSchema = z.object({
  validatorAddress: z.string().refine(isEthAddress, { message: "Invalid Ethereum address" }),
  amount: z.coerce.number().min(0.001, "Amount must be at least 0.001 USDT"),
  timeoutDays: z.coerce.number().min(1, "Period must be at least 1 day").max(365, "Max 365 days"),
  validatorRisk: z.enum(["active", "new", "slashed"] as const),
});

type FormValues = z.infer<typeof formSchema>;

const RISK_OPTIONS: { value: ValidatorRisk; label: string; description: string }[] = [
  { value: "active",  label: "Active",            description: "Validator has an established history with no slashes" },
  { value: "new",     label: "New / No history",  description: "Validator is new or has less than 30 days of history" },
  { value: "slashed", label: "Previously slashed", description: "Validator has had at least one slashing event" },
];

export default function SlashingProtection() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const { sdk, isReady: isSdkReady } = useZeusSDK();

  const [premiumBps, setPremiumBps] = useState(1500);
  const [premiumAmount, setPremiumAmount] = useState(0n);
  const [amountBigInt, setAmountBigInt] = useState(0n);
  const [isBuying, setIsBuying] = useState(false);

  // Fallback: use sendTransaction for unsupported SDK methods
  const { sendTransactionAsync } = useSendTransaction();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      validatorAddress: "",
      amount: 100,
      timeoutDays: 30,
      validatorRisk: "active",
    },
  });

  const watchAmount = form.watch("amount");
  const watchRisk   = form.watch("validatorRisk");

  const networkLabel = chainId === 677 ? "BOT Chain Mainnet" : chainId === 196 ? "X Layer Mainnet" : "Unknown";
  const isBotChain   = chainId === 677;

  // Live premium preview
  useEffect(() => {
    if (watchAmount > 0) {
      try {
        const amt = parseUsdc(watchAmount.toString());
        setAmountBigInt(amt);
        const bps = computeSlashingPremiumBps(chainId, watchRisk as ValidatorRisk);
        setPremiumBps(bps);
        setPremiumAmount(computeSlashingPremium(amt, chainId, watchRisk as ValidatorRisk));
      } catch {
        setAmountBigInt(0n);
        setPremiumAmount(0n);
      }
    }
  }, [watchAmount, watchRisk, chainId]);

  useEffect(() => {
    if (isSuccess) {
      toast({ title: "Slashing Policy Created!", description: "Your validator is now protected." });
      form.reset({ ...form.getValues(), validatorAddress: "" });
    }
  }, [isSuccess, form, toast]);

  async function onSubmit(values: FormValues) {
    if (!isConnected) {
      toast({ variant: "destructive", title: "Wallet not connected", description: "Please connect your wallet first." });
      return;
    }

    if (!isSdkReady) {
      toast({ variant: "destructive", title: "SDK not ready", description: "Wallet connection still initialising." });
      return;
    }

    setIsBuying(true);
    try {
      // buyInsurance(validator, amount, timeoutSeconds, retries=1)
      // The validator address is used as the "seller" in the insurance contract
      const timeoutSeconds = values.timeoutDays * 86400;
      const { policyId } = await sdk.insurance.createPolicy(
        values.validatorAddress,
        amountBigInt,
        timeoutSeconds,
        1,
      );
      toast({
        title: "Slashing Policy Created!",
        description: `Policy #${policyId} — validator ${values.validatorAddress.slice(0, 8)}… is now protected.`,
      });
      form.reset({ ...form.getValues(), validatorAddress: "" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : "Unknown error";
      toast({ variant: "destructive", title: "Purchase Failed", description: msg });
    } finally {
      setIsBuying(false);
    }
  }

  const totalCost = amountBigInt > 0n ? premiumAmount : 0n;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-2xl mx-auto space-y-6"
    >
      <div className="flex items-center gap-3 mb-8">
        <ShieldAlert className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-brand font-bold tracking-tight">Slashing Protection</h1>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {networkLabel} · USDT · Base rate {isBotChain ? "15%" : "12%"}
          </span>
        </div>
      </div>

      {/* Info card */}
      <Alert className="border-primary/20 bg-primary/5">
        <Info className="w-4 h-4 text-primary" />
        <AlertTitle className="font-mono uppercase text-xs tracking-wider text-primary">How it works</AlertTitle>
        <AlertDescription className="text-sm mt-1 text-muted-foreground">
          Protect your validator against slashing losses.
          If your validator is slashed during the coverage period, you receive the insured amount from the reserve.
          Premium rate: <span className="font-semibold text-foreground">{isBotChain ? "15–20%" : "12–17%"}</span> depending on validator history.
        </AlertDescription>
      </Alert>

      {!isConnected && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">Not Connected</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">
            Connect your wallet to purchase slashing protection.
          </AlertDescription>
        </Alert>
      )}

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <CardHeader>
              <CardTitle className="font-mono uppercase tracking-wider text-sm">Protection Details</CardTitle>
              <CardDescription>Enter your validator details to calculate the premium.</CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {/* Validator Address */}
              <FormField
                control={form.control}
                name="validatorAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">
                      Validator Address
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="0x..." className="font-mono bg-background/50" {...field} />
                    </FormControl>
                    <FormDescription className="text-xs">
                      The validator's withdrawal or operator address.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Amount + Period */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">
                        Coverage Amount (USDT)
                      </FormLabel>
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
                  name="timeoutDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">
                        Coverage Period (Days)
                      </FormLabel>
                      <FormControl>
                        <Input type="number" min="1" max="365" className="font-mono bg-background/50" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">1–365 days</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Validator Risk */}
              <FormField
                control={form.control}
                name="validatorRisk"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono uppercase text-xs tracking-wider text-muted-foreground">
                      Validator History
                    </FormLabel>
                    <div className="grid grid-cols-1 gap-2 mt-1">
                      {RISK_OPTIONS.map((opt) => {
                        const bps = computeSlashingPremiumBps(chainId, opt.value);
                        const isSelected = field.value === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => field.onChange(opt.value)}
                            className={cn(
                              "flex items-start gap-3 px-4 py-3 rounded-xl border text-left transition-all",
                              isSelected
                                ? "border-primary bg-primary/5"
                                : "border-border bg-background/30 hover:border-border/80 hover:bg-secondary/30",
                            )}
                          >
                            <div className={cn(
                              "mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center",
                              isSelected ? "border-primary" : "border-muted-foreground/40",
                            )}>
                              {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-sm">{opt.label}</span>
                                <span className="font-mono text-xs text-primary font-semibold">{bps / 100}%</span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Premium summary */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Premium Rate</span>
                  <span className="font-mono text-sm font-semibold">{premiumBps / 100}%</span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Coverage Amount</span>
                  <span className="font-mono text-sm">{watchAmount || 0} USDT</span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Coverage Period</span>
                  <span className="font-mono text-sm">{form.watch("timeoutDays")} days</span>
                </div>
                <div className="w-full h-px bg-primary/20 my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-mono text-sm uppercase tracking-wider text-primary font-bold">Premium Due</span>
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
                  : <><Swords className="mr-2 h-4 w-4" /> Buy Slashing Protection</>}
              </Button>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </motion.div>
  );
}
