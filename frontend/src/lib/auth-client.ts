const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export type AuthNonce = { nonce: string; message: string };
export function fetchNonce(address: string): Promise<AuthNonce> {
  return apiFetch(`/auth/nonce?address=${address}`);
}

export function fetchVerify(body: {
  address: string;
  signature: string;
  nonce: string;
}): Promise<{ ok: boolean }> {
  return apiFetch("/auth/verify", { method: "POST", body: JSON.stringify(body) });
}

export type AuthUser = { address: string; role: UserRole };
export function fetchMe(): Promise<AuthUser> {
  return apiFetch("/auth/me");
}

export function fetchLogout(): Promise<{ ok: boolean }> {
  return apiFetch("/auth/logout", { method: "POST" });
}

// ─── Admin — users ────────────────────────────────────────────────────────────

export type UserRole = "admin" | "partner" | "investor" | "oracle";

export type AdminUser = {
  walletAddress: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export function fetchAdminUsers(): Promise<{ users: AdminUser[] }> {
  return apiFetch("/admin/users");
}

export function fetchSetRole(address: string, role: UserRole): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/users/${address}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

// ─── Admin — API keys ─────────────────────────────────────────────────────────

export type ApiKeyRecord = {
  id: string;
  name: string;
  createdBy: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export function fetchApiKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiFetch("/admin/api-keys");
}

export function fetchCreateApiKey(name: string): Promise<{ id: string; key: string }> {
  return apiFetch("/admin/api-keys", { method: "POST", body: JSON.stringify({ name }) });
}

export function fetchRevokeApiKey(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/api-keys/${id}`, { method: "DELETE" });
}

// ─── Escrow ───────────────────────────────────────────────────────────────────

export type EscrowAgreement = {
  id: string;
  initiator: string;
  executor: string;
  amount: string;
  timeout: string;
  createdAt: string;
  status: "Active" | "Completed" | "Refunded" | "Unknown";
  proof: string;
};

export function fetchAgreements(address: string): Promise<{ agreements: EscrowAgreement[] }> {
  return apiFetch(`/escrow/agreements?address=${address}`);
}

export type PrepareResult = { to: `0x${string}`; data: `0x${string}` };

export function fetchPrepareDeposit(body: {
  executor: string;
  amount: string;
  timeoutSeconds: number;
}): Promise<PrepareResult> {
  return apiFetch("/escrow/prepare-deposit", { method: "POST", body: JSON.stringify(body) });
}

export function fetchPrepareConfirm(body: {
  agreementId: string;
  proof: string;
}): Promise<PrepareResult> {
  return apiFetch("/escrow/prepare-confirm", { method: "POST", body: JSON.stringify(body) });
}

export function fetchPrepareRefund(body: {
  agreementId: string;
}): Promise<PrepareResult> {
  return apiFetch("/escrow/prepare-refund", { method: "POST", body: JSON.stringify(body) });
}
