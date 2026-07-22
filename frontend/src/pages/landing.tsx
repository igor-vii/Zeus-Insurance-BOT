import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, ChevronRight, Shield, Zap, Eye, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import { ZeusLogoIcon } from '@/components/zeus-logo';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay },
});

/* ── Animated flow example ──────────────────────────────────────────────── */
const STEPS = [
  { id: 0, icon: '💳', label: 'Agent pays', value: '$1.00', sub: 'via x402 protocol', color: '#F5A623' },
  { id: 1, icon: '⚡', label: 'API fails', value: 'Detected', sub: 'on-chain oracle', color: '#ef4444' },
  { id: 2, icon: '🛡️', label: 'Zeus refunds', value: '$0.93', sub: 'in ~5 seconds', color: '#22c55e' },
];

function FlowDemo() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % 3), 1800);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative flex items-center gap-0 justify-center">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center">
          {/* Card */}
          <motion.div
            animate={{
              borderColor: active === i ? step.color + '80' : 'rgba(255,255,255,0.08)',
              backgroundColor: active === i ? step.color + '0d' : 'rgba(255,255,255,0.03)',
              scale: active === i ? 1.04 : 1,
            }}
            transition={{ duration: 0.35 }}
            className="relative w-44 rounded-xl border px-5 py-4 text-center"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            {active === i && (
              <motion.div
                layoutId="glow"
                className="absolute inset-0 rounded-xl blur-xl opacity-20"
                style={{ background: step.color }}
                transition={{ duration: 0.35 }}
              />
            )}
            <div className="relative">
              <div className="text-2xl mb-1">{step.icon}</div>
              <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-1">{step.label}</div>
              <div
                className="text-xl font-bold font-mono"
                style={{ color: active === i ? step.color : '#fff' }}
              >
                {step.value}
              </div>
              <div className="text-xs text-white/30 mt-0.5">{step.sub}</div>
            </div>
          </motion.div>

          {/* Arrow connector */}
          {i < 2 && (
            <div className="flex items-center px-2">
              <motion.div
                animate={{ opacity: active > i ? 1 : 0.2, x: active > i ? 0 : -4 }}
                transition={{ duration: 0.3 }}
              >
                <ChevronRight className="w-5 h-5 text-white/30" />
              </motion.div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Reserve Status Card ────────────────────────────────────────────────── */
function ReserveCard() {
  const [reserve, setReserve] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/reserve/status')
      .then((r) => r.json())
      .then((d) => {
        const v = Number(d?.reserveBalance ?? d?.balance ?? d?.totalReserve);
        if (!isNaN(v)) setReserve(v);
      })
      .catch(() => {});
  }, []);

  const displayReserve = reserve !== null ? `$${reserve.toFixed(2)}` : '$—';
  const pct = reserve !== null ? Math.min((reserve / 10000) * 100, 100) : 1;

  return (
    <motion.div
      {...fadeUp(0.15)}
      className="relative rounded-2xl border bg-card overflow-hidden"
      style={{ borderColor: 'rgba(255,255,255,0.1)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2">
          <ZeusLogoIcon size={22} />
          <span className="font-semibold text-white">Reserve Status</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          X Layer Mainnet
        </span>
      </div>

      {/* Reserve health */}
      <div className="px-6 py-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-end justify-between mb-3">
          <div>
            <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-1">Reserve Health</div>
            <div className="text-3xl font-bold text-white font-mono">{displayReserve}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-1">Min Threshold</div>
            <div className="text-lg font-bold text-primary font-mono">$100.00</div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, #F5A623, #22c55e)' }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 1, delay: 0.5 }}
          />
        </div>
      </div>

      {/* Bottom grid */}
      <div className="grid grid-cols-2">
        {/* Daily payout limits */}
        <div className="px-5 py-4 border-r" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-2">Daily Payout Limit</div>
          <div className="text-2xl font-bold text-white font-mono">$1,000</div>
          <div className="text-xs text-primary mt-1">Remaining today: $1,000</div>
        </div>

        {/* Fund reserve */}
        <div className="px-5 py-4">
          <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-2">Fund Reserve</div>
          <p className="text-xs text-white/50 leading-relaxed mb-3">
            Anyone can provide liquidity to protect AI agents from failed paid calls.
          </p>
          <Link href="/reserve">
            <button className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-mono text-white/70 hover:text-white transition-colors" style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.2)' }}>
              <span>Add USDC</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </Link>
        </div>
      </div>
    </motion.div>
  );
}

/* ── Main Landing ───────────────────────────────────────────────────────── */
export default function Landing() {
  return (
    <div className="overflow-hidden">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center">
        {/* Grid bg */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div
            className="absolute inset-0 opacity-[0.025]"
            style={{
              backgroundImage: `linear-gradient(rgba(245,166,35,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(245,166,35,0.6) 1px, transparent 1px)`,
              backgroundSize: '60px 60px',
            }}
          />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-primary/5 rounded-full blur-[140px]" />
        </div>

        <div className="relative w-full max-w-7xl mx-auto px-8 lg:px-12 py-24">
          <div className="grid grid-cols-2 gap-16 items-center">

            {/* Left col */}
            <div>
              {/* Live badge */}
              <motion.div {...fadeUp(0)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 mb-8">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-mono text-primary uppercase tracking-wider">
                  Zeus Insurance live on X Layer Mainnet
                </span>
              </motion.div>

              {/* Headline */}
              <motion.h1 {...fadeUp(0.08)} className="text-6xl xl:text-7xl font-bold leading-[1.05] tracking-tight mb-6 text-white">
                On-chain<br />
                insurance for<br />
                <span className="text-primary">AI agents</span><br />
                that cannot<br />
                afford failed<br />
                API calls.
              </motion.h1>

              <motion.p {...fadeUp(0.18)} className="text-base text-white/50 leading-relaxed mb-10 max-w-md">
                Zeus protects agents and Web3 services with smart-contract escrow, USDC reserves, automated compensation, and x402 payment flows — live on X Layer Mainnet.
              </motion.p>

              {/* CTAs */}
              <motion.div {...fadeUp(0.26)} className="flex items-center gap-3 mb-16">
                <Link href="/dashboard">
                  <button className="flex items-center gap-2 px-6 py-3 rounded-full font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors">
                    <ArrowUpRight className="w-4 h-4" />
                    Open App
                  </button>
                </Link>
                <a
                  href="https://github.com/igor-vii/Zeus-Insurance-Escrow"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-6 py-3 rounded-full font-mono text-sm text-white/70 hover:text-white transition-colors"
                  style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  View GitHub
                  <ArrowRight className="w-4 h-4" />
                </a>
              </motion.div>

              {/* Metric chips */}
              <motion.div {...fadeUp(0.34)} className="flex items-center gap-3">
                {[
                  { label: 'PREMIUM', value: '7%+', sub: 'Risk-adjusted bps' },
                  { label: 'TOKEN', value: 'USDC', sub: 'X Layer Mainnet' },
                  { label: 'FLOW', value: 'x402', sub: 'Agent payments' },
                ].map((chip) => (
                  <div
                    key={chip.label}
                    className="px-5 py-3 rounded-xl"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-1">{chip.label}</div>
                    <div className="text-lg font-bold text-white font-mono">{chip.value}</div>
                    <div className="text-xs text-white/35 mt-0.5">{chip.sub}</div>
                  </div>
                ))}
              </motion.div>
            </div>

            {/* Right col — Reserve card */}
            <div>
              <ReserveCard />
            </div>
          </div>
        </div>
      </section>

      {/* ── Simple Example ────────────────────────────────────────────────── */}
      <section className="py-20 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div
            className="text-center mb-12"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <Zap className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">How it works in practice</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-3">
              See the magic happen in <span className="text-primary">5 seconds</span>
            </h2>
            <p className="text-white/40 text-sm max-w-lg mx-auto">
              Your agent pays $1 for an API call. The seller fails to deliver. Zeus detects the failure on-chain and returns $0.93 automatically.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-2xl mx-auto"
          >
            <div
              className="rounded-2xl p-8"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <FlowDemo />

              {/* Detail row */}
              <div className="mt-8 grid grid-cols-3 gap-4 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: 'Premium paid', value: '$0.07', note: '7% of insured amount' },
                  { label: 'Amount insured', value: '$1.00', note: 'USDC on X Layer' },
                  { label: 'Refund received', value: '$0.93', note: 'net of premium' },
                ].map((item) => (
                  <div key={item.label} className="text-center">
                    <div className="text-xs text-white/30 uppercase font-mono tracking-wider mb-1">{item.label}</div>
                    <div className="text-xl font-bold text-white font-mono">{item.value}</div>
                    <div className="text-xs text-white/30 mt-0.5">{item.note}</div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Services / Features ───────────────────────────────────────────── */}
      <section className="py-20 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div
            className="mb-14"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">Our Services</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-3">Built for the Agent Economy</h2>
            <p className="text-white/40 text-sm max-w-lg">Every feature is designed to make M2M commerce safe and reliable on X Layer Mainnet.</p>
          </motion.div>

          <div className="grid grid-cols-2 gap-5">
            {[
              {
                icon: Zap,
                tag: 'Insurance',
                title: 'Instant Automated Payouts',
                desc: 'Smart contracts detect API failures on-chain and automatically pay out from the reserve fund. No disputes, no delays — settlement in seconds.',
                stat: '~5s',
                statLabel: 'avg payout time',
              },
              {
                icon: Shield,
                tag: 'Escrow',
                title: 'On-Chain Escrow Protection',
                desc: 'ZeusEscrowBOT holds funds in smart contract escrow until service delivery is confirmed. Both parties are protected without a trusted third party.',
                stat: '100%',
                statLabel: 'non-custodial',
              },
              {
                icon: Eye,
                tag: 'Transparency',
                title: 'Fully Auditable On-Chain',
                desc: 'Every policy, premium, and payout is recorded on X Layer Mainnet (Chain ID 196). Fully auditable by anyone, forever.',
                stat: 'Chain 196',
                statLabel: 'X Layer Mainnet',
              },
              {
                icon: Cpu,
                tag: 'Agent-Native',
                title: 'x402 Protocol Integration',
                desc: 'AI agents buy and claim policies via REST API using the x402 payment protocol — zero human interaction required. MCP server included.',
                stat: 'REST + MCP',
                statLabel: 'agent APIs',
              },
            ].map(({ icon: Icon, tag, title, desc, stat, statLabel }, i) => (
              <motion.div
                key={title}
                className="group relative rounded-2xl p-7 hover:border-primary/30 transition-all duration-300 cursor-default"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
              >
                <div className="flex items-start justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 group-hover:bg-primary/20 transition-colors">
                      <Icon className="w-4.5 h-4.5 text-primary" />
                    </div>
                    <span className="text-xs font-mono text-white/35 uppercase tracking-wider">{tag}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-primary font-mono">{stat}</div>
                    <div className="text-xs text-white/30">{statLabel}</div>
                  </div>
                </div>
                <h3 className="font-semibold text-white mb-2">{title}</h3>
                <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Protocol stats ─────────────────────────────────────────────────── */}
      <section className="py-16 border-t border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="grid grid-cols-4 gap-8">
            {[
              { value: '7%', label: 'Premium rate', sub: 'Risk-adjusted bps' },
              { value: '$1,000', label: 'Daily payout cap', sub: 'Per reserve cycle' },
              { value: '93%', label: 'Net refund rate', sub: 'After premium deduction' },
              { value: '196', label: 'Chain ID', sub: 'X Layer Mainnet (OKX)' },
            ].map((s, i) => (
              <motion.div
                key={s.label}
                className="text-center"
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
              >
                <div className="text-4xl font-bold text-primary font-mono mb-1">{s.value}</div>
                <div className="text-sm font-medium text-white mb-0.5">{s.label}</div>
                <div className="text-xs text-white/30">{s.sub}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────────── */}
      <section className="py-24">
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div
            className="relative rounded-2xl overflow-hidden text-center py-20 px-8"
            style={{ background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.15)' }}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.55 }}
          >
            {/* subtle glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-48 bg-primary/10 rounded-full blur-[80px]" />
            <div className="relative">
              <motion.div
                animate={{ rotate: [0, 5, -5, 0] }}
                transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
                className="inline-block mb-6"
              >
                <ZeusLogoIcon size={44} />
              </motion.div>
              <h2 className="text-3xl font-bold text-white mb-3">Ready to Protect Your Payments?</h2>
              <p className="text-white/40 text-base mb-10 max-w-md mx-auto">
                Join the decentralized insurance protocol for AI agents. Live on X Layer Mainnet now.
              </p>
              <div className="flex items-center gap-3 justify-center">
                <Link href="/dashboard">
                  <button className="flex items-center gap-2 px-7 py-3 rounded-full font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors">
                    <ArrowUpRight className="w-4 h-4" />
                    Launch App
                  </button>
                </Link>
                <Link href="/docs">
                  <button
                    className="flex items-center gap-2 px-7 py-3 rounded-full font-mono text-sm text-white/60 hover:text-white transition-colors"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    View Documentation
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </Link>
              </div>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
