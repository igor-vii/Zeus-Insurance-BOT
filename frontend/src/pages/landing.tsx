import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, ChevronRight, Shield, Zap, Eye, Cpu, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import { ZeusLogoIcon } from '@/components/zeus-logo';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay },
});

const inView = (delay = 0) => ({
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
  transition: { duration: 0.45, delay },
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
              <div className="text-xl font-bold font-mono" style={{ color: active === i ? step.color : '#fff' }}>
                {step.value}
              </div>
              <div className="text-xs text-white/30 mt-0.5">{step.sub}</div>
            </div>
          </motion.div>
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
        <div className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            X Layer Mainnet
          </span>
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            BOT Chain Mainnet
          </span>
        </div>
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
        <div className="px-5 py-4 border-r" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-2">Daily Payout Limit</div>
          <div className="text-2xl font-bold text-white font-mono">$1,000</div>
          <div className="text-xs text-primary mt-1">Remaining today: $1,000</div>
        </div>
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

/* ── Partner logos ──────────────────────────────────────────────────────── */
const PARTNERS = [
  {
    name: 'OKX',
    desc: 'X Layer Mainnet',
    logo: (
      <svg viewBox="0 0 60 20" fill="currentColor" className="h-5 w-auto">
        <text x="0" y="16" fontSize="18" fontWeight="700" fontFamily="monospace">OKX</text>
      </svg>
    ),
  },
  {
    name: 'GSA',
    desc: 'Global Settlement',
    logo: (
      <svg viewBox="0 0 60 20" fill="currentColor" className="h-5 w-auto">
        <text x="0" y="16" fontSize="18" fontWeight="700" fontFamily="monospace">GSA</text>
      </svg>
    ),
  },
  {
    name: 'x402',
    desc: 'Payment Protocol',
    logo: (
      <svg viewBox="0 0 65 20" fill="currentColor" className="h-5 w-auto">
        <text x="0" y="16" fontSize="18" fontWeight="700" fontFamily="monospace">x402</text>
      </svg>
    ),
  },
  {
    name: 'BOT Chain',
    desc: 'Chain 677',
    logo: (
      <svg viewBox="0 0 100 20" fill="currentColor" className="h-5 w-auto">
        <text x="0" y="16" fontSize="15" fontWeight="700" fontFamily="monospace">BOT Chain</text>
      </svg>
    ),
  },
];

/* ── How It Works steps ─────────────────────────────────────────────────── */
const HOW_STEPS = [
  {
    num: '01',
    icon: '🛡️',
    title: 'Insure',
    desc: 'Buy a policy via SDK or API. Choose coverage amount, timeout, and product type — Standard or Slashing Protection.',
    color: '#F5A623',
  },
  {
    num: '02',
    icon: '💸',
    title: 'Transact',
    desc: 'Your AI agent executes transactions freely. The policy covers losses from API failures or slashing events.',
    color: '#3b82f6',
  },
  {
    num: '03',
    icon: '🔍',
    title: 'Verify',
    desc: 'On-chain oracles monitor service delivery and validator behaviour. Evidence is cryptographically recorded.',
    color: '#a855f7',
  },
  {
    num: '04',
    icon: '⚡',
    title: 'Settle',
    desc: 'Automatic payout from the reserve fund in ~5 seconds. No disputes, no manual claims, no human required.',
    color: '#22c55e',
  },
];

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
              {/* Live badges */}
              <motion.div {...fadeUp(0)} className="flex flex-wrap items-center gap-2 mb-8">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-green-500/30 bg-green-500/5">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs font-mono text-green-400 uppercase tracking-wider">X Layer Mainnet</span>
                </div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs font-mono text-primary uppercase tracking-wider">BOT Chain Mainnet</span>
                </div>
              </motion.div>

              {/* Headline */}
              <motion.h1 {...fadeUp(0.08)} className="text-6xl xl:text-7xl font-bold leading-[1.05] tracking-tight mb-4 text-white">
                Trust Layer<br />
                for the<br />
                <span className="text-primary">Agentic Economy</span>
              </motion.h1>

              <motion.p {...fadeUp(0.14)} className="text-lg font-semibold text-white/70 mb-3">
                Your payment layer under Zeus protection
              </motion.p>

              <motion.p {...fadeUp(0.18)} className="text-base text-white/45 leading-relaxed mb-10 max-w-md">
                Trust layer for AI agents — decentralized insurance and escrow for autonomous transactions.
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
                  { label: 'TOKEN', value: 'USDT', sub: 'BOT Chain · USDC on X Layer' },
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

      {/* ── Partners ──────────────────────────────────────────────────────── */}
      <section className="py-10 border-t border-b" style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-white/25 uppercase tracking-widest shrink-0 mr-8">Ecosystem</span>
            <div className="flex items-center justify-around w-full gap-8">
              {PARTNERS.map((p) => (
                <motion.div
                  key={p.name}
                  className="flex flex-col items-center gap-1 group cursor-default"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4 }}
                >
                  <div className="text-white/30 group-hover:text-white/70 transition-colors font-bold font-mono text-lg tracking-tight">
                    {p.name}
                  </div>
                  <div className="text-xs text-white/20 font-mono">{p.desc}</div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── How It Works ──────────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="text-center mb-16" {...inView()}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">How it works</span>
            </div>
            <h2 className="text-4xl font-bold text-white mb-3">
              Four steps to <span className="text-primary">full protection</span>
            </h2>
            <p className="text-white/40 text-sm max-w-lg mx-auto">
              From policy purchase to automatic settlement — no human intervention at any step.
            </p>
          </motion.div>

          <div className="relative">
            {/* connector line */}
            <div
              className="absolute top-10 left-0 right-0 h-px hidden lg:block"
              style={{ background: 'linear-gradient(90deg, transparent, rgba(245,166,35,0.2), rgba(245,166,35,0.2), transparent)', margin: '0 12.5%' }}
            />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
              {HOW_STEPS.map((step, i) => (
                <motion.div
                  key={step.num}
                  className="relative flex flex-col items-center text-center p-6 rounded-2xl"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                  {...inView(i * 0.1)}
                >
                  {/* Step number */}
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 text-2xl relative"
                    style={{ background: step.color + '15', border: `1px solid ${step.color}30` }}
                  >
                    <span>{step.icon}</span>
                    <div
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono"
                      style={{ background: step.color, color: '#000' }}
                    >
                      {i + 1}
                    </div>
                  </div>
                  <div className="text-xs font-mono uppercase tracking-widest mb-2" style={{ color: step.color }}>
                    {step.num}
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">{step.title}</h3>
                  <p className="text-sm text-white/40 leading-relaxed">{step.desc}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Simple Example ────────────────────────────────────────────────── */}
      <section className="py-20 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="text-center mb-12" {...inView()}>
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

          <motion.div {...inView(0.1)} className="max-w-2xl mx-auto">
            <div
              className="rounded-2xl p-8"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <FlowDemo />
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
          <motion.div className="mb-14" {...inView()}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">Our Services</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-3">Built for the Agent Economy</h2>
            <p className="text-white/40 text-sm max-w-lg">Every feature is designed to make M2M commerce safe and reliable on X Layer Mainnet and BOT Chain.</p>
          </motion.div>

          <div className="grid grid-cols-2 gap-5">
            {[
              {
                icon: Zap,
                tag: 'Insurance',
                title: 'Молниеносные выплаты',
                desc: 'Smart contracts detect API failures on-chain and automatically pay out from the reserve fund. No disputes, no delays — settlement in seconds.',
                stat: '~5s',
                statLabel: 'avg payout time',
              },
              {
                icon: Shield,
                tag: 'Escrow',
                title: 'Защищённая сделка',
                desc: 'ZeusEscrowBOT holds funds in smart contract escrow until service delivery is confirmed. Both parties are protected without a trusted third party.',
                stat: '100%',
                statLabel: 'non-custodial',
              },
              {
                icon: Eye,
                tag: 'Transparency',
                title: 'Fully Auditable On-Chain',
                desc: 'Every policy, premium, and payout is recorded on X Layer Mainnet (Chain 196) and BOT Chain (Chain 677). Fully auditable by anyone, forever.',
                stat: '677 · 196',
                statLabel: 'Chain IDs',
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
                {...inView(i * 0.07)}
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
              { value: '677', label: 'BOT Chain ID', sub: 'BOT Chain Mainnet' },
            ].map((s, i) => (
              <motion.div
                key={s.label}
                className="text-center"
                {...inView(i * 0.07)}
              >
                <div className="text-4xl font-bold text-primary font-mono mb-1">{s.value}</div>
                <div className="text-sm font-medium text-white mb-0.5">{s.label}</div>
                <div className="text-xs text-white/30">{s.sub}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Developer SDK ─────────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="grid grid-cols-2 gap-16 items-center">

            {/* Left */}
            <motion.div {...inView()}>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
                <Cpu className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-mono text-white/50 uppercase tracking-wider">For developers</span>
              </div>
              <h2 className="text-4xl font-bold text-white mb-4">
                Add insurance in<br /><span className="text-primary">3 clicks</span> via SDK
              </h2>
              <p className="text-white/40 text-sm leading-relaxed mb-8 max-w-md">
                The Zeus SDK connects directly to your AI agent's wallet. One import, one method call — your transactions are protected on BOT Chain or X Layer Mainnet.
              </p>
              <div className="flex flex-col gap-3">
                {[
                  '1. Install: pnpm add @zeus-insurance/sdk',
                  '2. Connect wallet + choose network',
                  '3. Call createPolicy() — done',
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <span className="text-sm font-mono text-white/60">{step}</span>
                  </div>
                ))}
              </div>
              <div className="mt-8 flex items-center gap-3">
                <a
                  href="https://github.com/igor-vii/Zeus-Insurance-Escrow"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors"
                >
                  <ArrowUpRight className="w-4 h-4" />
                  Examples on GitHub
                </a>
                <Link href="/docs">
                  <button
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full font-mono text-sm text-white/60 hover:text-white transition-colors"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    SDK Docs
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </Link>
              </div>
            </motion.div>

            {/* Right — code block */}
            <motion.div {...inView(0.1)}>
              <div
                className="rounded-2xl overflow-hidden"
                style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {/* Code header */}
                <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)' }}>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
                  </div>
                  <span className="text-xs font-mono text-white/25">agent.ts</span>
                  <div />
                </div>

                {/* Code body */}
                <pre className="px-6 py-6 text-xs font-mono leading-6 overflow-x-auto" style={{ color: 'rgba(255,255,255,0.7)' }}>
{`import { ZeusSDK } from `}<span style={{ color: '#F5A623' }}>'@zeus-insurance/sdk'</span>{`;

`}<span style={{ color: '#60a5fa' }}>const</span>{` zeus = `}<span style={{ color: '#60a5fa' }}>new</span>{` `}<span style={{ color: '#22c55e' }}>ZeusSDK</span>{`({
  network: `}<span style={{ color: '#F5A623' }}>'bot-chain-mainnet'</span>{`,
  walletClient,          `}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// wagmi / viem`}</span>{`
});

`}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// Create standard insurance policy`}</span>{`
`}<span style={{ color: '#60a5fa' }}>const</span>{` policy = `}<span style={{ color: '#60a5fa' }}>await</span>{` zeus.insurance.`}<span style={{ color: '#22c55e' }}>createPolicy</span>{`({
  amount: `}<span style={{ color: '#a78bfa' }}>1_000_000n</span>{`,    `}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// 1 USDT`}</span>{`
  timeoutSeconds: `}<span style={{ color: '#a78bfa' }}>3600</span>{`,
});

`}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// Or slashing protection for validators`}</span>{`
`}<span style={{ color: '#60a5fa' }}>const</span>{` slash = `}<span style={{ color: '#60a5fa' }}>await</span>{` zeus.insurance
  .`}<span style={{ color: '#22c55e' }}>createSlashingProtectionPolicy</span>{`({
    validatorAddress: `}<span style={{ color: '#F5A623' }}>'0xABC…'</span>{`,
    amount: `}<span style={{ color: '#a78bfa' }}>5_000_000n</span>{`,
    timeoutSeconds: `}<span style={{ color: '#a78bfa' }}>86400</span>{`,
  });`}
                </pre>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────────── */}
      <section className="py-24">
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div
            className="relative rounded-2xl overflow-hidden text-center py-20 px-8"
            style={{ background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.15)' }}
            {...inView()}
          >
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
                Join the decentralized insurance protocol for AI agents. Live on X Layer Mainnet and BOT Chain now.
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
