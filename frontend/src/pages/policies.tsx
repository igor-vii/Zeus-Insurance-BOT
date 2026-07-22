import { useState, useEffect, useCallback } from "react";
import {
  useAccount, usePublicClient, useSendTransaction, useWaitForTransactionReceipt,
} from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { parseAbiItem } from "viem";
import {
  Shield, AlertTriangle, ExternalLink, Loader2, SearchX, ServerCrash, RefreshCw, Blocks,
} from "lucide-react";
import { ZEUS_INSURANCE_ADDRESS, INSURANCE_DEPLOY_BLOCK, formatUsdc } from "@/lib/contracts";
import { useApiMode } from "@/lib/api-mode";
import { fetchPolicies, fetchPrepareClaim, type ApiPolicy, ApiError } from "@/lib/api-client";
import { useZeusSDK } from "@/hooks/useZeusSDK";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";

type NormalizedPolicy = {
  id: string;
  seller: string;
  amount: bigint;
  premium: bigint;
  retryDeadline: bigint;
  isActive: boolean;
  isPaidOut: boolean;
  isExpired: boolean;
};

function apiPolicyToNormalized(p: ApiPolicy): NormalizedPolicy {
  return {
    id: p.id,
    seller: p.seller,
    amount: BigInt(p.amount),
    premium: BigInt(p.premium),
    retryDeadline: BigInt(p.retryDeadline),
    isActive: p.isActive,
    isPaidOut: p.isPaidOut,
    isExpired: p.isExpired,
  };
}

/** Decode a friendly error message from SDK or API errors. */
function decodeClaimError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const msg = err.message;
  // Match known contract revert strings embedded in the SDK error message
  const friendly: Record<string, string> = {
    "Only buyer can claim": "Only the policy buyer can claim this.",
    "Policy not active": "Policy is not active.",
    "Already paid out": "This claim has already been paid out.",
    "Policy expired": "Policy has expired.",
    "Timeout not yet reached": "Policy is not yet claimable — deadline hasn't passed.",
    "ClaimNotApproved": "Policy is not yet claimable — deadline hasn't passed or policy is not active.",
    "ClaimAlreadyFulfilled": "This claim has already been paid out.",
    "DailyPayoutLimitExceeded": "Daily payout limit exceeded. Try again tomorrow.",
    "InsufficientReserve": "Reserve doesn't have enough funds for this payout.",
    "ReserveBelowThreshold": "Reserve is below the minimum threshold.",
    "NotInsuranceContract": "Caller is not the insurance contract (internal error).",
  };
  for (const [key, label] of Object.entries(friendly)) {
    if (msg.includes(key)) return label;
  }
  if (msg.includes("rejected") || msg.includes("user rejected")) return "Transaction rejected in wallet.";
  return msg.split("\n")[0];
}

export default function Policies() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { toast } = useToast();
  const { isApiMode } = useApiMode();
  const { sdk, isReady: isSdkReady } = useZeusSDK();

  const [currentTime, setCurrentTime] = useState(Math.floor(Date.now() / 1000));
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Math.floor(Date.now() / 1000)), 10000);
    return () => clearInterval(timer);
  }, []);

  // ─── Direct mode: event log scan ──────────────────────────────────────────
  const [policyIds, setPolicyIds] = useState<bigint[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [syncedBlock, setSyncedBlock] = useState<bigint | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [directRefetchKey, setDirectRefetchKey] = useState(0);
  const [scanProgress, setScanProgress] = useState<{ scanned: bigint; total: bigint } | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!address || !publicClient || isApiMode) return;
    setIsLoadingLogs(true);
    setScanProgress(null);
    try {
      const CHUNK = 2000n;
      const latestBlock = await publicClient.getBlockNumber();
      const totalBlocks = latestBlock - INSURANCE_DEPLOY_BLOCK + 1n;
      const event = parseAbiItem(
        "event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline)",
      );
      const allLogs: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
      let cursor = INSURANCE_DEPLOY_BLOCK;

      console.info(`[policies] Scanning ${totalBlocks.toLocaleString()} blocks (${INSURANCE_DEPLOY_BLOCK}–${latestBlock}) in chunks of ${CHUNK}`);

      while (cursor <= latestBlock) {
        const chunkEnd = cursor + CHUNK - 1n < latestBlock ? cursor + CHUNK - 1n : latestBlock;
        const chunk = await publicClient.getLogs({
          address: ZEUS_INSURANCE_ADDRESS,
          event,
          args: { buyer: address as `0x${string}` },
          fromBlock: cursor,
          toBlock: chunkEnd,
        });
        allLogs.push(...chunk);
        const scanned = chunkEnd - INSURANCE_DEPLOY_BLOCK + 1n;
        setScanProgress({ scanned, total: totalBlocks });
        cursor = chunkEnd + 1n;
      }

      const ids = allLogs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((l) => (l as any).args?.policyId as bigint | undefined)
        .filter((id): id is bigint => id !== undefined);
      const unique = [...new Set(ids)].sort((a, b) => (b > a ? 1 : -1));
      console.info(`[policies] Found ${unique.length} policy IDs:`, unique.map(String));
      setPolicyIds(unique);
      setSyncedBlock(latestBlock);
      setSyncedAt(new Date());
    } catch (err) {
      console.error("[policies] Error fetching logs:", err);
      toast({
        variant: "destructive",
        title: "Log Scan Failed",
        description: err instanceof Error ? err.message.split("\n")[0] : "Unknown error",
      });
    } finally {
      setIsLoadingLogs(false);
      setScanProgress(null);
    }
  }, [address, publicClient, isApiMode, toast]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs, directRefetchKey]);

  // ─── Direct mode: batch read policies via SDK ──────────────────────────────
  const {
    data: directPoliciesData,
    isLoading: isLoadingPolicies,
    refetch: refetchDirect,
  } = useQuery({
    queryKey: ["direct-policies", policyIds.map(String), directRefetchKey],
    queryFn: () => Promise.all(policyIds.map((id) => sdk.insurance.getPolicy(Number(id)))),
    enabled: !isApiMode && policyIds.length > 0 && isSdkReady,
  });

  // ─── API mode: single fetch ────────────────────────────────────────────────
  const {
    data: apiPoliciesData,
    isLoading: isLoadingApi,
    error: apiError,
    refetch: refetchApi,
  } = useQuery({
    queryKey: ["policies", address],
    queryFn: () => fetchPolicies(address!),
    enabled: isApiMode && !!address,
    retry: 1,
  });

  // ─── API mode claim — sendTransaction ─────────────────────────────────────
  const { sendTransactionAsync, isPending: isClaimingApi } = useSendTransaction();
  const [apiClaimHash, setApiClaimHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isWaitingApiClaim, isSuccess: isApiClaimSuccess } =
    useWaitForTransactionReceipt({ hash: apiClaimHash });

  useEffect(() => {
    if (isApiClaimSuccess) {
      toast({ title: "Claim Successful", description: "Payout has been processed from the reserve." });
      setClaimError(null);
      setClaimingId(null);
      refetchApi();
    }
  }, [isApiClaimSuccess, toast, refetchApi]);

  const isClaiming = isApiMode
    ? (isClaimingApi || isWaitingApiClaim)
    : claimingId !== null;

  async function handleClaim(idStr: string, idBigInt?: bigint) {
    setClaimError(null);
    setClaimingId(idStr);

    if (isApiMode) {
      try {
        const result = await fetchPrepareClaim(idStr);
        const hash = await sendTransactionAsync({ to: result.to, data: result.data });
        setApiClaimHash(hash);
      } catch (e: unknown) {
        const msg = e instanceof ApiError
          ? `API error ${e.status}: ${e.message}`
          : decodeClaimError(e);
        setClaimError(msg);
        setClaimingId(null);
        toast({ variant: "destructive", title: "Claim Failed", description: msg });
      }
    } else {
      // Direct mode — SDK handles the full claim tx and awaits receipt
      const policyId = idBigInt !== undefined ? Number(idBigInt) : Number(idStr);
      if (!isSdkReady) {
        const msg = "SDK not ready — please wait for wallet connection to initialise.";
        setClaimError(msg);
        setClaimingId(null);
        toast({ variant: "destructive", title: "Claim Failed", description: msg });
        return;
      }
      console.info("[claim] SDK direct mode — claimPayout(", policyId, ")");
      try {
        await sdk.insurance.claimPayout(policyId);
        console.info("[claim] Claim successful for policy", policyId);
        toast({ title: "Claim Successful", description: "Payout has been processed from the reserve." });
        setClaimError(null);
        setClaimingId(null);
        refetchDirect();
        setDirectRefetchKey((k) => k + 1);
      } catch (e: unknown) {
        const msg = decodeClaimError(e);
        setClaimError(msg);
        setClaimingId(null);
        toast({ variant: "destructive", title: "Claim Failed", description: msg });
      }
    }
  }

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  function getStatusBadge(p: NormalizedPolicy, isClaimable: boolean) {
    if (p.isPaidOut) return <Badge variant="outline" className="border-primary text-primary">Paid Out</Badge>;
    if (p.isExpired) return <Badge variant="secondary" className="text-muted-foreground">Expired</Badge>;
    if (isClaimable) return <Badge variant="destructive" className="bg-destructive/20 text-destructive border-none">Claimable</Badge>;
    if (p.isActive) return <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-none">Active</Badge>;
    return <Badge variant="outline">Unknown</Badge>;
  }

  // Build normalized policy list
  const normalizedPolicies: NormalizedPolicy[] = isApiMode
    ? (apiPoliciesData?.policies ?? []).map(apiPolicyToNormalized)
    : (directPoliciesData ?? []).map((p, idx) => ({
        id: policyIds[idx].toString(),
        seller: p.seller,
        amount: p.amount,
        premium: p.premium,
        retryDeadline: BigInt(p.retryDeadline),
        isActive: p.isActive,
        isPaidOut: p.isPaidOut,
        isExpired: p.isExpired,
      }));

  const isLoading = isApiMode ? isLoadingApi : (isLoadingLogs || isLoadingPolicies);
  const hasNoPolicies = !isLoading && normalizedPolicies.length === 0;
  const fetchError = isApiMode && apiError
    ? apiError instanceof ApiError
      ? `API error ${apiError.status}: ${apiError.message}`
      : "API unavailable"
    : null;

  const progressPct = scanProgress
    ? Math.min(100, Number((scanProgress.scanned * 100n) / scanProgress.total))
    : 0;

  if (!isConnected) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-8">
          <Shield className="w-8 h-8 text-primary" />
          <h1 className="text-3xl font-brand font-bold tracking-tight">My Policies</h1>
        </div>
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">Not Connected</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">
            Connect your wallet to view your purchased policies.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-6xl mx-auto space-y-6"
    >
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-3xl font-brand font-bold tracking-tight">My Policies</h1>
            {isApiMode && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">via API</span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {!isApiMode && (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-card/60 text-xs font-mono">
                <Blocks className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                {isLoadingLogs ? (
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {scanProgress ? `${progressPct}% scanned` : "Scanning chain…"}
                  </span>
                ) : syncedBlock !== null ? (
                  <>
                    <span className="text-muted-foreground">Block</span>
                    <a
                      href={`https://sepolia.basescan.org/block/${syncedBlock}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline underline-offset-2"
                    >
                      #{syncedBlock.toLocaleString()}
                    </a>
                    {syncedAt && (
                      <span className="text-muted-foreground/60">
                        · {formatDistanceToNow(syncedAt, { addSuffix: true })}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground/60">Not synced</span>
                )}
              </div>
              {isLoadingLogs && scanProgress && (
                <div className="w-48">
                  <Progress value={progressPct} className="h-1" />
                </div>
              )}
            </div>
          )}

          <Button
            onClick={() => {
              if (isApiMode) refetchApi();
              else setDirectRefetchKey((k) => k + 1);
            }}
            variant="outline" size="sm"
            disabled={isLoadingLogs}
            className="font-mono text-xs uppercase tracking-wider gap-2"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingLogs ? "animate-spin" : ""}`} />
            {isLoadingLogs ? "Scanning…" : "Refresh"}
          </Button>
        </div>
      </div>

      {fetchError && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <ServerCrash className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">API Unavailable</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">{fetchError} — try switching to Direct mode.</AlertDescription>
        </Alert>
      )}

      {claimError && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle className="font-mono uppercase text-xs tracking-wider">Claim Failed</AlertTitle>
          <AlertDescription className="text-sm font-mono mt-1">{claimError}</AlertDescription>
        </Alert>
      )}

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
        {hasNoPolicies ? (
          <div className="flex flex-col items-center justify-center p-12 text-center">
            <div className="w-16 h-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
              <SearchX className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-brand font-bold mb-2">No Policies Found</h3>
            <p className="text-muted-foreground text-sm max-w-md">
              You haven't purchased any insurance policies yet. Protect your next transaction by buying coverage.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50 hover:bg-transparent">
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground w-16">ID</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">Seller</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">Insured Amt</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">Premium</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">Deadline</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">Status</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i} className="border-border/50">
                      <TableCell><Skeleton className="h-4 w-8 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-6 w-16 bg-secondary" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-20 ml-auto bg-secondary" /></TableCell>
                    </TableRow>
                  ))
                  : normalizedPolicies.map((p) => {
                    const deadlineMs = Number(p.retryDeadline) * 1000;
                    const isClaimable = p.isActive && !p.isPaidOut && !p.isExpired && currentTime >= Number(p.retryDeadline);
                    const isThisClaiming = claimingId === p.id && isClaiming;
                    return (
                      <TableRow key={p.id} className="border-border/50 transition-colors hover:bg-secondary/10">
                        <TableCell className="font-mono text-sm">#{p.id}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{truncateAddress(p.seller)}</TableCell>
                        <TableCell className="font-mono text-sm font-medium">${formatUsdc(p.amount)}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">${formatUsdc(p.premium)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.isActive && !p.isExpired && !p.isPaidOut ? (
                            <span title={new Date(deadlineMs).toLocaleString()}>
                              {currentTime < Number(p.retryDeadline)
                                ? formatDistanceToNow(deadlineMs, { addSuffix: true })
                                : "Now"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </TableCell>
                        <TableCell>{getStatusBadge(p, isClaimable)}</TableCell>
                        <TableCell className="text-right">
                          {isClaimable && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="font-mono text-[10px] uppercase tracking-wider h-8 bg-primary text-primary-foreground hover:bg-primary/90 border-none"
                              onClick={() => handleClaim(p.id, policyIds.find(id => id.toString() === p.id))}
                              disabled={isClaiming}
                            >
                              {isThisClaiming
                                ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                : <ExternalLink className="w-3 h-3 mr-1" />}
                              {isThisClaiming ? "Claiming…" : "Claim"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
