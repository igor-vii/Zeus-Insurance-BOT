import { useState, useEffect, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { fetchNonce, fetchVerify, fetchMe, fetchLogout, type AuthUser } from "@/lib/auth-client";

type AuthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error"; message: string };

export function useAuth() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<AuthState>({ status: "idle" });

  // Check existing session on mount / when wallet connects
  useEffect(() => {
    if (!isConnected) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    fetchMe()
      .then((user) => setState({ status: "authenticated", user }))
      .catch(() => setState({ status: "idle" }));
  }, [isConnected, address]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setState({ status: "loading" });
    try {
      const { nonce, message } = await fetchNonce(address);
      const signature = await signMessageAsync({ message });
      await fetchVerify({ address, signature, nonce });
      const user = await fetchMe();
      setState({ status: "authenticated", user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      setState({ status: "error", message: msg });
    }
  }, [address, signMessageAsync]);

  const signOut = useCallback(async () => {
    await fetchLogout().catch(() => null);
    setState({ status: "idle" });
  }, []);

  return {
    state,
    isAuthenticated: state.status === "authenticated",
    user: state.status === "authenticated" ? state.user : null,
    isLoading: state.status === "loading",
    signIn,
    signOut,
  };
}
