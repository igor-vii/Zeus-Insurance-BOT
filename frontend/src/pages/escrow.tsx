import { useState } from "react";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgreements,
  fetchPrepareDeposit,
  fetchPrepareConfirm,
  fetchPrepareRefund,
  fetchAdminUsers,
  fetchSetRole,
  fetchApiKeys,
  fetchCreateApiKey,
  fetchRevokeApiKey,
  type EscrowAgreement,
  type UserRole,
  type AdminUser,
  type ApiKeyRecord,
} from "@/lib/auth-client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, KeyRound, ShieldCheck, Copy, Check, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { WalletModal } from "@/components/wallet-modal";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6;

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function statusColor(s: EscrowAgreement["status"]) {
  return {
    Active: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    Completed: "bg-green-500/15 text-green-400 border-green-500/30",
    Refunded: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    Unknown: "bg-muted text-muted-foreground",
  }[s] ?? "bg-muted text-muted-foreground";
}

function isTimedOut(ag: EscrowAgreement) {
  const deadline = Number(ag.createdAt) + Number(ag.timeout);
  return Date.now() / 1000 >= deadline;
}

function formatUSDC(raw: string) {
  try {
    const n = Number(BigInt(raw)) / 10 ** USDC_DECIMALS;
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  } catch {
    return raw;
  }
}

function formatTimeout(seconds: string) {
  const s = Number(seconds);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// ─── Sign-in gate ─────────────────────────────────────────────────────────────

function SignInGate() {
  const { address, isConnected } = useAccount();
  const { state, signIn, isLoading } = useAuth();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <ShieldCheck className="w-12 h-12 text-primary/40" />
        <p className="text-muted-foreground text-sm">Connect your wallet to access the Escrow dashboard.</p>
        <WalletModal trigger={<Button className="font-mono uppercase tracking-wider text-xs">Connect Wallet</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <ShieldCheck className="w-12 h-12 text-primary/40" />
      <p className="text-sm text-muted-foreground">
        Sign a message to verify ownership of <span className="font-mono text-foreground">{shortAddr(address!)}</span>
      </p>
      {state.status === "error" && (
        <p className="text-xs text-destructive">{state.message}</p>
      )}
      <Button onClick={signIn} disabled={isLoading} className="font-mono uppercase tracking-wider text-xs">
        {isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing…</> : "Sign In"}
      </Button>
    </div>
  );
}

// ─── Create agreement form ────────────────────────────────────────────────────

function CreateAgreementForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const { sendTransactionAsync } = useSendTransaction();
  const [executor, setExecutor] = useState("");
  const [amount, setAmount] = useState("");
  const [timeout, setTimeout_] = useState("86400");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const amountRaw = parseUnits(amount, USDC_DECIMALS).toString();
      const { to, data } = await fetchPrepareDeposit({
        executor,
        amount: amountRaw,
        timeoutSeconds: Number(timeout),
      });
      await sendTransactionAsync({ to, data });
      toast({ title: "Agreement created", description: "Funds locked in escrow." });
      setExecutor(""); setAmount(""); setTimeout_("86400");
      onSuccess();
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "Transaction failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 bg-card border border-border rounded-xl p-6">
      <h3 className="font-semibold text-sm">New Escrow Agreement</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Executor address</label>
          <Input placeholder="0x…" value={executor} onChange={(e) => setExecutor(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Amount (USDC)</label>
          <Input type="number" step="0.01" min="0.01" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Timeout (seconds)</label>
          <Input type="number" min="60" value={timeout} onChange={(e) => setTimeout_(e.target.value)} required />
        </div>
      </div>
      <Button type="submit" disabled={busy} className="w-full font-mono uppercase tracking-wider text-xs">
        {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</> : "Deposit & Create"}
      </Button>
    </form>
  );
}

// ─── Agreements table ─────────────────────────────────────────────────────────

function AgreementsTable({
  agreements,
  role,
  myAddress,
  onRefresh,
}: {
  agreements: EscrowAgreement[];
  role: "initiator" | "executor";
  myAddress: string;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const { sendTransactionAsync } = useSendTransaction();
  const [proofDialog, setProofDialog] = useState<EscrowAgreement | null>(null);
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = agreements.filter((ag) =>
    role === "initiator"
      ? ag.initiator.toLowerCase() === myAddress.toLowerCase()
      : ag.executor.toLowerCase() === myAddress.toLowerCase(),
  );

  async function handleRefund(ag: EscrowAgreement) {
    setBusy(ag.id);
    try {
      const { to, data } = await fetchPrepareRefund({ agreementId: ag.id });
      await sendTransactionAsync({ to, data });
      toast({ title: "Refund requested", description: `Agreement #${ag.id} refunded.` });
      onRefresh();
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm() {
    if (!proofDialog) return;
    setBusy(proofDialog.id);
    try {
      const { to, data } = await fetchPrepareConfirm({ agreementId: proofDialog.id, proof });
      await sendTransactionAsync({ to, data });
      toast({ title: "Execution confirmed", description: `Agreement #${proofDialog.id} completed.` });
      setProofDialog(null);
      setProof("");
      onRefresh();
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (!visible.length) {
    return <p className="text-muted-foreground text-sm py-8 text-center">No agreements found.</p>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 border-b border-border">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">ID</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">{role === "initiator" ? "Executor" : "Initiator"}</th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground text-xs">Amount</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Timeout</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Proof</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((ag) => (
              <tr key={ag.id} className="hover:bg-muted/10 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">#{ag.id}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {shortAddr(role === "initiator" ? ag.executor : ag.initiator)}
                  <CopyButton text={role === "initiator" ? ag.executor : ag.initiator} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">{formatUSDC(ag.amount)} USDC</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimeout(ag.timeout)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusColor(ag.status)}`}>
                    {ag.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-[120px] truncate">
                  {ag.proof && ag.proof !== "0x" ? (
                    <span title={ag.proof}>{ag.proof.slice(0, 14)}…</span>
                  ) : (
                    <span className="opacity-40">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {ag.status === "Active" && role === "initiator" && isTimedOut(ag) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === ag.id}
                      onClick={() => handleRefund(ag)}
                      className="text-xs h-7"
                    >
                      {busy === ag.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refund"}
                    </Button>
                  )}
                  {ag.status === "Active" && role === "executor" && (
                    <Button
                      size="sm"
                      disabled={busy === ag.id}
                      onClick={() => { setProofDialog(ag); setProof(""); }}
                      className="text-xs h-7"
                    >
                      {busy === ag.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Confirm execution dialog */}
      <Dialog open={!!proofDialog} onOpenChange={(o) => !o && setProofDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Execution — Agreement #{proofDialog?.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="text-xs text-muted-foreground block">
              Proof (IPFS CID, tx hash, URL — stored on-chain as-is)
            </label>
            <Input
              placeholder="ipfs://Qm…  or  0x…  or leave blank"
              value={proof}
              onChange={(e) => setProof(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProofDialog(null)}>Cancel</Button>
            <Button onClick={handleConfirm} disabled={busy === proofDialog?.id}>
              {busy === proofDialog?.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm & Release"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

const ROLES: UserRole[] = ["admin", "partner", "investor", "oracle"];

function AdminPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyResult, setNewKeyResult] = useState<{ id: string; key: string } | null>(null);
  const [busyRole, setBusyRole] = useState<string | null>(null);

  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: fetchAdminUsers });
  const keysQ = useQuery({ queryKey: ["admin-keys"], queryFn: fetchApiKeys });

  const createKey = useMutation({
    mutationFn: fetchCreateApiKey,
    onSuccess: (data) => {
      setNewKeyResult(data);
      setNewKeyName("");
      qc.invalidateQueries({ queryKey: ["admin-keys"] });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const revokeKey = useMutation({
    mutationFn: fetchRevokeApiKey,
    onSuccess: () => {
      toast({ title: "API key revoked" });
      qc.invalidateQueries({ queryKey: ["admin-keys"] });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  async function handleRoleChange(user: AdminUser, role: UserRole) {
    setBusyRole(user.walletAddress);
    try {
      await fetchSetRole(user.walletAddress, role);
      toast({ title: "Role updated", description: `${shortAddr(user.walletAddress)} → ${role}` });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "Failed", variant: "destructive" });
    } finally {
      setBusyRole(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Role management */}
      <section>
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" /> User Roles
        </h3>
        {usersQ.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading users…</div>
        ) : usersQ.error ? (
          <p className="text-sm text-destructive">{usersQ.error.message}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Address</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Role</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Since</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usersQ.data?.users.map((u) => (
                  <tr key={u.walletAddress} className="hover:bg-muted/10">
                    <td className="px-4 py-3 font-mono text-xs">
                      {shortAddr(u.walletAddress)}
                      <CopyButton text={u.walletAddress} />
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={u.role}
                        onValueChange={(v) => handleRoleChange(u, v as UserRole)}
                        disabled={busyRole === u.walletAddress}
                      >
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* API Keys */}
      <section>
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" /> API Keys
        </h3>

        {/* Generate new key */}
        <form
          onSubmit={(e) => { e.preventDefault(); if (newKeyName.trim()) createKey.mutate(newKeyName.trim()); }}
          className="flex gap-2 mb-4"
        >
          <Input
            placeholder="Key name (e.g. Oracle Bot #1)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={createKey.isPending || !newKeyName.trim()} size="sm">
            {createKey.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
          </Button>
        </form>

        {/* One-time key reveal */}
        {newKeyResult && (
          <div className="mb-4 p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-yellow-400 mb-1">Copy this key — it will not be shown again</p>
              <div className="flex items-center gap-2 font-mono text-xs bg-background/50 rounded px-3 py-2 border border-border">
                <span className="truncate">{newKeyResult.key}</span>
                <CopyButton text={newKeyResult.key} />
              </div>
            </div>
            <button onClick={() => setNewKeyResult(null)} className="text-muted-foreground hover:text-foreground text-xs ml-auto shrink-0">Dismiss</button>
          </div>
        )}

        {keysQ.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading keys…</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Created by</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keysQ.data?.keys.map((k) => (
                  <tr key={k.id} className="hover:bg-muted/10">
                    <td className="px-4 py-3 text-xs font-medium">{k.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{shortAddr(k.createdBy)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={k.isActive ? "default" : "secondary"} className="text-[11px]">
                        {k.isActive ? "Active" : "Revoked"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {k.isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 text-destructive hover:text-destructive"
                          disabled={revokeKey.isPending}
                          onClick={() => revokeKey.mutate(k.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {!keysQ.data?.keys.length && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground text-xs">No API keys yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EscrowPage() {
  const { address, isConnected } = useAccount();
  const { isAuthenticated, user, isLoading } = useAuth();
  const qc = useQueryClient();

  const agreementsQ = useQuery({
    queryKey: ["escrow-agreements", address],
    queryFn: () => fetchAgreements(address!),
    enabled: !!address && isAuthenticated,
    refetchInterval: 30_000,
  });

  if (!isConnected || !isAuthenticated) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return <SignInGate />;
  }

  const agreements = agreementsQ.data?.agreements ?? [];
  const isAdmin = user?.role === "admin";

  const tabs = [
    { id: "initiator", label: "As Initiator" },
    { id: "executor", label: "As Executor" },
    ...(isAdmin ? [{ id: "admin", label: "Admin" }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Escrow</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Trustless agreements on BOT Chain
            {user && (
              <span className="ml-2">
                <Badge variant="outline" className="text-[11px] font-mono">{user.role}</Badge>
              </span>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => qc.invalidateQueries({ queryKey: ["escrow-agreements"] })}
          disabled={agreementsQ.isFetching}
        >
          {agreementsQ.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      <Tabs defaultValue="initiator">
        <TabsList className="bg-muted/30">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="text-xs font-medium">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── Initiator tab ── */}
        <TabsContent value="initiator" className="space-y-6 mt-6">
          <CreateAgreementForm onSuccess={() => qc.invalidateQueries({ queryKey: ["escrow-agreements"] })} />
          <div>
            <h3 className="text-sm font-semibold mb-3">My Agreements</h3>
            {agreementsQ.isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
            ) : (
              <AgreementsTable
                agreements={agreements}
                role="initiator"
                myAddress={address!}
                onRefresh={() => qc.invalidateQueries({ queryKey: ["escrow-agreements"] })}
              />
            )}
          </div>
        </TabsContent>

        {/* ── Executor tab ── */}
        <TabsContent value="executor" className="space-y-4 mt-6">
          <div>
            <h3 className="text-sm font-semibold mb-3">Agreements to Fulfil</h3>
            {agreementsQ.isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
            ) : (
              <AgreementsTable
                agreements={agreements}
                role="executor"
                myAddress={address!}
                onRefresh={() => qc.invalidateQueries({ queryKey: ["escrow-agreements"] })}
              />
            )}
          </div>
        </TabsContent>

        {/* ── Admin tab ── */}
        {isAdmin && (
          <TabsContent value="admin" className="mt-6">
            <AdminPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
