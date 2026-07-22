import { useState } from "react";
import { useConnect, useAccount, useSwitchChain } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { baseSepolia } from "wagmi/chains";
import { Wallet, X, Loader2, ExternalLink, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

function MetaMaskIcon() {
  return (
    <svg viewBox="0 0 40 40" fill="none" className="w-7 h-7">
      <path d="M35.4 4L22.1 13.7l2.4-5.8L35.4 4z" fill="#E17726" stroke="#E17726" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4.6 4l13.2 9.8-2.3-5.9L4.6 4z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M30.3 27.5l-3.5 5.4 7.5 2.1 2.1-7.3-6.1-.2z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3.6 27.7l2.1 7.3 7.5-2.1-3.5-5.4-6.1.2z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12.8 18.2l-2 3.1 7.2.3-.2-7.8-5 4.4z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M27.2 18.2l-5.1-4.5-.2 7.9 7.2-.3-1.9-3.1z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13.2 32.9l4.4-2.1-3.8-3-1.8 5.1h1.2z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M22.4 30.8l4.4 2.1h1.1l-1.7-5-4 2.9z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CoinbaseIcon() {
  return (
    <svg viewBox="0 0 40 40" fill="none" className="w-7 h-7">
      <rect width="40" height="40" rx="10" fill="#0052FF"/>
      <circle cx="20" cy="20" r="12" fill="white"/>
      <path d="M20 11.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zm-3 11.25v-5.5h6v5.5h-6z" fill="#0052FF"/>
    </svg>
  );
}

function WalletConnectIcon() {
  return (
    <svg viewBox="0 0 40 40" fill="none" className="w-7 h-7">
      <rect width="40" height="40" rx="10" fill="#3B99FC"/>
      <path d="M11.5 16.5c4.7-4.6 12.3-4.6 17 0l.6.5c.2.2.2.6 0 .8l-2 2c-.1.1-.3.1-.4 0l-.8-.8c-3.3-3.2-8.6-3.2-11.9 0l-.8.8c-.1.1-.3.1-.4 0l-2-2c-.2-.2-.2-.6 0-.8l.7-.5zm20.9 3.9l1.8 1.8c.2.2.2.6 0 .8l-8 7.8c-.2.2-.6.2-.8 0l-5.7-5.5c-.1-.1-.2-.1-.2 0l-5.7 5.5c-.2.2-.6.2-.8 0l-8-7.8c-.2-.2-.2-.6 0-.8l1.8-1.8c.2-.2.6-.2.8 0l5.7 5.5c.1.1.2.1.2 0l5.7-5.5c.2-.2.6-.2.8 0l5.7 5.5c.1.1.2.1.2 0l5.7-5.5c.2-.2.5-.2.8 0z" fill="white"/>
    </svg>
  );
}

type ViewState = "pick" | "switch-network";

interface WalletModalProps {
  trigger: React.ReactNode;
  className?: string;
}

export function WalletModal({ trigger, className }: WalletModalProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewState>("pick");

  const { connect, isPending, variables } = useConnect();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching, error: switchError } = useSwitchChain();

  const isWrongNetwork = isConnected && chainId !== baseSepolia.id;

  const connectingId = variables?.connector
    ? (variables.connector as { id?: string }).id
    : undefined;

  function openModal() {
    if (isConnected && isWrongNetwork) {
      setView("switch-network");
    } else {
      setView("pick");
    }
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setView("pick");
  }

  const wallets = [
    {
      id: "injected",
      name: "MetaMask / Browser",
      description: "Any injected wallet (MetaMask, Brave, etc.)",
      icon: <MetaMaskIcon />,
      connector: injected({ shimDisconnect: true }),
    },
    {
      id: "coinbaseWallet",
      name: "Coinbase Wallet",
      description: "Coinbase Wallet app or extension",
      icon: <CoinbaseIcon />,
      connector: coinbaseWallet({ appName: "Zeus Insurance", appLogoUrl: "/favicon.svg" }),
    },
    ...(wcProjectId
      ? [{
          id: "walletConnect",
          name: "WalletConnect",
          description: "Scan with any WalletConnect-compatible wallet",
          icon: <WalletConnectIcon />,
          connector: walletConnect({
            projectId: wcProjectId,
            metadata: {
              name: "Zeus Insurance",
              description: "Decentralized insurance for AI agent payments",
              url: "https://zeus-insurance-v2.netlify.app",
              icons: ["https://zeus-insurance-v2.netlify.app/favicon.svg"],
            },
          }),
        }]
      : []),
  ] as const;

  function handleConnect(option: typeof wallets[number]) {
    connect(
      { connector: option.connector },
      {
        onSuccess: (data) => {
          if (data.chainId !== baseSepolia.id) {
            setView("switch-network");
          } else {
            closeModal();
          }
        },
        onError: () => {
          setView("pick");
        },
      },
    );
  }

  function handleSwitchNetwork() {
    switchChain(
      { chainId: baseSepolia.id },
      {
        onSuccess: () => closeModal(),
      },
    );
  }

  return (
    <>
      <div onClick={openModal} className={cn("cursor-pointer", className)}>
        {trigger}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={closeModal}
          />

          {/* Modal */}
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">

            {/* ── VIEW: pick wallet ── */}
            {view === "pick" && (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                  <div className="flex items-center gap-2.5">
                    <Wallet className="w-4 h-4 text-primary" />
                    <span className="font-semibold text-sm">Connect Wallet</span>
                  </div>
                  <button
                    onClick={closeModal}
                    className="p-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="p-3 space-y-1.5">
                  {wallets.map((option) => {
                    const isConnecting = isPending && connectingId === option.id;
                    return (
                      <button
                        key={option.id}
                        onClick={() => handleConnect(option)}
                        disabled={isPending}
                        className={cn(
                          "w-full flex items-center gap-4 px-4 py-3.5 rounded-xl",
                          "text-left transition-all duration-150",
                          "border border-transparent",
                          "hover:bg-secondary/50 hover:border-border",
                          "disabled:opacity-60 disabled:cursor-not-allowed",
                          isConnecting && "bg-primary/5 border-primary/20",
                        )}
                      >
                        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-secondary/50 flex items-center justify-center overflow-hidden">
                          {isConnecting
                            ? <Loader2 className="w-5 h-5 text-primary animate-spin" />
                            : option.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm text-foreground">{option.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">{option.description}</div>
                        </div>
                        {!isPending && (
                          <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="px-5 py-3 border-t border-border/50 text-center">
                  <p className="text-[10px] text-muted-foreground/60 font-mono">
                    Base Sepolia Testnet · Chain ID 84532
                  </p>
                </div>
              </>
            )}

            {/* ── VIEW: wrong network ── */}
            {view === "switch-network" && (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-yellow-500" />
                    <span className="font-semibold text-sm">Wrong Network</span>
                  </div>
                  <button
                    onClick={closeModal}
                    className="p-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="px-5 py-6 flex flex-col items-center gap-4 text-center">
                  {/* Chain badge */}
                  <div className="w-16 h-16 rounded-2xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                    <AlertTriangle className="w-8 h-8 text-yellow-500" />
                  </div>

                  <div>
                    <p className="font-semibold text-sm text-foreground mb-1">
                      Wallet connected to wrong network
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Zeus Insurance runs on <span className="text-foreground font-medium">Base Sepolia</span> (chain ID 84532).
                      Switch your wallet to continue.
                    </p>
                  </div>

                  {/* Target network pill */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border text-xs font-mono">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                    Base Sepolia · Chain 84532
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary ml-1" />
                  </div>

                  {switchError && (
                    <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg w-full">
                      {switchError.message.split("\n")[0]}
                    </p>
                  )}

                  <Button
                    className="w-full font-mono uppercase tracking-wider text-xs"
                    onClick={handleSwitchNetwork}
                    disabled={isSwitching}
                  >
                    {isSwitching
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Switching…</>
                      : "Switch to Base Sepolia"}
                  </Button>

                  <button
                    onClick={() => setView("pick")}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    ← Choose a different wallet
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
