import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useAccount, useChainId, useWaitForTransactionReceipt } from "wagmi";
import { isAddress } from "viem";
import { Shield, Loader2, AlertTriangle, ShieldCheck, Zap } from "lucide-react";
import { getTokenSymbol } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { fetchSlashingPremium } from "@/lib/api-client";

function getChainLabel(chainId: number): string {
  if (chainId === 677) return "BOT Chain";
  if (chainId === 196) return "X Layer";
  return "BOT Chain";
}

const formSchema = z.object({
  validatorAddress: z
    .string()
    .refine((v): boolean => isAddress(v), { message: "Некорректный Ethereum-адрес" }),
  amount: z.coerce
    .number()
    .min(0.001, "Минимальная сумма — 0.001")
    .positive("Введите положительную сумму"),
  timeoutDays: z.coerce.number().min(1, "Минимум 1 день").max(365, "Максимум 365 дней"),
});

type FormValues = z.infer<typeof formSchema>;

export default function SlashingProtection() {
  const { isConnected } = useAccount();
  const { toast } = useToast();
  const chainId = useChainId();
  const tokenSymbol = getTokenSymbol(chainId);
  const chainLabel = getChainLabel(chainId);

  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const [premium, setPremium] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [isPremiumLoading, setIsPremiumLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // suppress unused warning — txHash used via useWaitForTransactionReceipt
  void setTxHash;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      validatorAddress: "",
      amount: 0.001,
      timeoutDays: 30,
    },
  });

  const watchedAmount = form.watch("amount");
  const watchedValidator = form.watch("validatorAddress");

  // Fetch premium from API whenever validator or amount changes (debounced 600ms)
  useEffect(() => {
    if (!watchedAmount || !watchedValidator || !isAddress(watchedValidator)) {
      setPremium(null);
      setRate(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsPremiumLoading(true);
      try {
        const result = await fetchSlashingPremium({
          validator: watchedValidator,
          amount: watchedAmount,
          chainId,
        });
        setPremium(result.premium);
        setRate(result.rate);
      } catch {
        setPremium(null);
        setRate(null);
      } finally {
        setIsPremiumLoading(false);
      }
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [watchedAmount, watchedValidator, chainId]);

  function onSubmit(values: FormValues) {
    if (!isConnected) {
      toast({ title: "Кошелёк не подключён", variant: "destructive" });
      return;
    }
    toast({
      title: "Функция в разработке",
      description: `Покупка страховки от слэшинга для ${values.validatorAddress.slice(0, 8)}… будет доступна после деплоя контракта.`,
    });
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 p-4">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-yellow-500/10">
            <Zap className="h-6 w-6 text-yellow-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Страховка от слэшинга на {chainLabel}
            </h1>
            <p className="text-muted-foreground text-sm">
              Защита валидаторов от потерь при слэшинге •{" "}
              <Badge variant="outline" className="text-xs">
                {chainLabel}
              </Badge>
            </p>
          </div>
        </div>
      </motion.div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-yellow-400" />
            Купить полис
          </CardTitle>
          <CardDescription>
            Укажите адрес валидатора и параметры страхования
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!isConnected && (
            <Alert className="mb-4" variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Кошелёк не подключён</AlertTitle>
              <AlertDescription>
                Подключите кошелёк для покупки страховки
              </AlertDescription>
            </Alert>
          )}

          {isSuccess && (
            <Alert className="mb-4 border-green-500/30 bg-green-500/10">
              <ShieldCheck className="h-4 w-4 text-green-400" />
              <AlertTitle className="text-green-400">Полис активирован</AlertTitle>
              <AlertDescription className="text-green-300">
                Транзакция подтверждена. Ваш валидатор застрахован.
              </AlertDescription>
            </Alert>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField
                control={form.control}
                name="validatorAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Адрес валидатора</FormLabel>
                    <FormControl>
                      <Input placeholder="0x…" {...field} />
                    </FormControl>
                    <FormDescription>
                      Адрес кошелька валидатора, который нужно застраховать
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Сумма страхования ({tokenSymbol})</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="0.001"
                        step="0.001"
                        placeholder="0.001"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Максимальная выплата при слэшинге
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="timeoutDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Срок действия (дней)</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="365" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Premium block — fetched from API */}
              <div className="rounded-lg border bg-muted/30 p-4 min-h-[64px] flex flex-col justify-center">
                {isPremiumLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Рассчитываем премию…</span>
                  </div>
                ) : premium !== null && rate !== null ? (
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Ставка</span>
                      <span>{rate}%</span>
                    </div>
                    <div className="flex justify-between font-semibold text-base">
                      <span>Премия</span>
                      <span className="text-yellow-400">
                        {premium.toFixed(4)} {tokenSymbol}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs text-center">
                    Введите адрес валидатора и сумму для расчёта премии
                  </p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-semibold"
                disabled={!isConnected || isConfirming || isPremiumLoading}
              >
                {isConfirming ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Подтверждение…
                  </>
                ) : (
                  <>
                    <Shield className="mr-2 h-4 w-4" />
                    Купить страховку
                  </>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card className="bg-muted/20">
        <CardContent className="pt-4 space-y-2 text-xs text-muted-foreground">
          <p>
            Выплаты производятся в <strong>{tokenSymbol}</strong> из резервного фонда.
          </p>
          <p>
            Премия рассчитывается автоматически на основе истории слэшингов валидатора.
          </p>
          <p>
            При слэшинге оракул подтверждает событие и резерв выплачивает {tokenSymbol}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
