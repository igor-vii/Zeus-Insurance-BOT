import API_BASE from "./api-base";

// ─── Error type ───────────────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.detail);
  }
  return res.json() as Promise<T>;
}

// ─── Quote ───────────────────────────────────────────────────────────────────
export type QuoteResult = {
  premiumBps: number;
  premiumAmount: string; // raw USDC bigint as decimal string
  totalCost: string;
};

export function fetchQuote(amount: string, maxRetries: number): Promise<QuoteResult> {
  return apiFetch(`/quote?amount=${amount}&maxRetries=${maxRetries}`);
}

// ─── Prepare buy ─────────────────────────────────────────────────────────────
export type PrepareBuyResult = {
  to: `0x${string}`;
  data: `0x${string}`;
  premiumAmount: string; // raw USDC bigint as decimal string
};

export function fetchPrepareBuy(params: {
  seller: string;
  amount: string;
  timeoutSeconds: number;
  maxRetries: number;
}): Promise<PrepareBuyResult> {
  return apiFetch("/prepare-buy", { method: "POST", body: JSON.stringify(params) });
}

// ─── Policies ────────────────────────────────────────────────────────────────
export type ApiPolicy = {
  id: string;
  buyer: string;
  seller: string;
  amount: string;     // raw USDC bigint as decimal string
  premium: string;
  retryDeadline: string;
  maxRetries: string;
  isActive: boolean;
  isPaidOut: boolean;
  isExpired: boolean;
};

export function fetchPolicies(buyer: string): Promise<{ policies: ApiPolicy[] }> {
  return apiFetch(`/policies?buyer=${buyer}`);
}

export function fetchPolicy(id: string): Promise<{ policy: ApiPolicy }> {
  return apiFetch(`/policies/${id}`);
}

// ─── Claim ───────────────────────────────────────────────────────────────────
export type ClaimResult = {
  to: `0x${string}`;
  data: `0x${string}`;
};

export function fetchPrepareClaim(policyId: string): Promise<ClaimResult> {
  return apiFetch("/claim", { method: "POST", body: JSON.stringify({ policyId }) });
}

// ─── Health ──────────────────────────────────────────────────────────────────
export type HealthResult = { status: string };

export function fetchHealth(): Promise<HealthResult> {
  return apiFetch("/healthz");
}

// ─── Reserve ─────────────────────────────────────────────────────────────────
export type ReserveStats = {
  balance: string;
  minThreshold: string;
  maxDailyPayout: string;
  remainingDailyPayout: string;
  isAdequatelyFunded: boolean;
};

export function fetchReserve(): Promise<ReserveStats> {
  return apiFetch("/reserve");
}

// ─── Slashing Premium ─────────────────────────────────────────────────────────

export type SlashingPremiumResult = {
  premium: number; // absolute amount in token units
  rate: number;    // percentage, e.g. 15 / 18 / 20
};

export function fetchSlashingPremium(params: {
  validator: string;
  amount: number;
  chainId: number;
}): Promise<SlashingPremiumResult> {
  return apiFetch("/slashing/premium", { method: "POST", body: JSON.stringify(params) });
}
