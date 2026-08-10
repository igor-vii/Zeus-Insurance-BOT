import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, ChevronRight, Shield, Zap, Eye, Cpu, CheckCircle2, Calculator } from 'lucide-react';
import { motion, useScroll, useTransform, useSpring, useInView } from 'framer-motion';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ZeusLogoIcon } from '@/components/zeus-logo';

/* ── Animation helpers ──────────────────────────────────────────────────── */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1], delay },
});

const slideIn = (dir: 'left' | 'right' | 'up' = 'up', delay = 0) => ({
  initial: { opacity: 0, x: dir === 'left' ? -32 : dir === 'right' ? 32 : 0, y: dir === 'up' ? 24 : 0 },
  whileInView: { opacity: 1, x: 0, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1], delay },
});

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 28, scale: 0.97 },
  whileInView: { opacity: 1, y: 0, scale: 1 },
  viewport: { once: true, margin: '-40px' },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: i * 0.09 },
});

/* ── Count-up for stats ─────────────────────────────────────────────────── */
function CountUp({ to, prefix = '', suffix = '', decimals = 0 }: { to: number; prefix?: string; suffix?: string; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!isInView) return;
    const start = performance.now();
    const duration = 1200;
    const raf = (ts: number) => {
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setVal(eased * to);
      if (progress < 1) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }, [isInView, to]);

  return (
    <span ref={ref}>
      {prefix}{val.toFixed(decimals)}{suffix}
    </span>
  );
}

/* ── Premium Calculator ─────────────────────────────────────────────────── */
const COVERAGE_TYPES = [
  { id: 'standard', label: 'Standard', bps: 700, desc: 'API failure & service non-delivery' },
  { id: 'slashing', label: 'Slashing Protection', bps: 500, desc: 'Validator slashing events' },
] as const;

const NETWORKS = [
  { id: 'xlayer', label: 'X Layer', token: 'USDC', chain: 196 },
  { id: 'botchain', label: 'BOT Chain', token: 'USDT', chain: 677 },
] as const;

const PERIODS = [
  { id: '1h', label: '1 hr', seconds: 3600 },
  { id: '24h', label: '24 hr', seconds: 86400 },
  { id: '7d', label: '7 days', seconds: 604800 },
] as const;

function PremiumCalculator() {
  const [amount, setAmount] = useState(100);
  const [coverageIdx, setCoverageIdx] = useState(0);
  const [networkIdx, setNetworkIdx] = useState(1);
  const [periodIdx, setPeriodIdx] = useState(1);

  const coverage = COVERAGE_TYPES[coverageIdx];
  const network = NETWORKS[networkIdx];
  const period = PERIODS[periodIdx];

  const premium = (amount * coverage.bps) / 10000;
  const netPayout = amount - premium;
  const premiumPct = coverage.bps / 100;

  const handleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setAmount(Number(e.target.value));
  }, []);

  return (
    <motion.div
      {...slideIn('up')}
      className="relative rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.09)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-7 py-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center">
            <Calculator className="w-4 h-4 text-primary" />
          </div>
          <span className="font-semibold text-white">Premium Calculator</span>
        </div>
        <span className="text-xs font-mono text-white/30 uppercase tracking-wider">Real-time estimate</span>
      </div>

      <div className="p-7 grid grid-cols-2 gap-8">
        {/* Left — inputs */}
        <div className="flex flex-col gap-6">
          {/* Amount */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-mono text-white/40 uppercase tracking-wider">Coverage Amount</label>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono text-white/40">{network.token}</span>
                <input
                  type="number"
                  value={amount}
                  min={1}
                  max={10000}
                  onChange={(e) => setAmount(Math.max(1, Math.min(10000, Number(e.target.value))))}
                  className="w-20 bg-transparent text-right text-sm font-bold font-mono text-white focus:outline-none"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.15)' }}
                />
              </div>
            </div>
            {/* Slider */}
            <div className="relative h-5 flex items-center">
              <div className="absolute inset-x-0 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(amount / 10000) * 100}%`, background: 'linear-gradient(90deg, #F5A623, #22c55e)' }}
                />
              </div>
              <input
                type="range" min={1} max={10000} step={1} value={amount}
                onChange={handleSlider}
                className="absolute inset-x-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-xs text-white/20 font-mono">$1</span>
              <span className="text-xs text-white/20 font-mono">$10,000</span>
            </div>
          </div>

          {/* Coverage type */}
          <div>
            <label className="text-xs font-mono text-white/40 uppercase tracking-wider mb-2 block">Coverage Type</label>
            <div className="flex flex-col gap-2">
              {COVERAGE_TYPES.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => setCoverageIdx(i)}
                  className="flex items-start gap-3 px-4 py-3 rounded-xl text-left transition-all duration-200"
                  style={{
                    background: coverageIdx === i ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${coverageIdx === i ? 'rgba(245,166,35,0.3)' : 'rgba(255,255,255,0.06)'}`,
                  }}
                >
                  <div className="w-4 h-4 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0"
                    style={{ borderColor: coverageIdx === i ? '#F5A623' : 'rgba(255,255,255,0.2)' }}>
                    {coverageIdx === i && <div className="w-2 h-2 rounded-full bg-primary" />}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{c.label}</div>
                    <div className="text-xs text-white/35 mt-0.5">{c.desc} — {c.bps / 100}% premium</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Network + Period row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-mono text-white/40 uppercase tracking-wider mb-2 block">Network</label>
              <div className="flex flex-col gap-1.5">
                {NETWORKS.map((n, i) => (
                  <button key={n.id} onClick={() => setNetworkIdx(i)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono transition-all"
                    style={{
                      background: networkIdx === i ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${networkIdx === i ? 'rgba(245,166,35,0.25)' : 'rgba(255,255,255,0.06)'}`,
                      color: networkIdx === i ? '#F5A623' : 'rgba(255,255,255,0.4)',
                    }}>
                    <div className={`w-1.5 h-1.5 rounded-full ${networkIdx === i ? 'bg-primary' : 'bg-white/20'}`} />
                    {n.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-mono text-white/40 uppercase tracking-wider mb-2 block">Period</label>
              <div className="flex flex-col gap-1.5">
                {PERIODS.map((p, i) => (
                  <button key={p.id} onClick={() => setPeriodIdx(i)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono transition-all"
                    style={{
                      background: periodIdx === i ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${periodIdx === i ? 'rgba(245,166,35,0.25)' : 'rgba(255,255,255,0.06)'}`,
                      color: periodIdx === i ? '#F5A623' : 'rgba(255,255,255,0.4)',
                    }}>
                    <div className={`w-1.5 h-1.5 rounded-full ${periodIdx === i ? 'bg-primary' : 'bg-white/20'}`} />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right — results */}
        <div className="flex flex-col gap-4">
          {/* Big result card */}
          <div className="rounded-2xl p-6 flex-1 flex flex-col justify-between relative overflow-hidden"
            style={{ background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.15)' }}>
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-[40px]" />
            <div className="relative">
              <div className="text-xs font-mono text-white/35 uppercase tracking-wider mb-1">You pay (premium)</div>
              <motion.div
                key={premium.toFixed(4)}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="text-5xl font-bold text-primary font-mono"
              >
                ${premium.toFixed(2)}
              </motion.div>
              <div className="text-sm text-white/30 mt-1">{premiumPct}% of ${amount.toLocaleString()} {network.token}</div>
            </div>

            <div className="relative mt-4 flex flex-col gap-3">
              <div className="h-px" style={{ background: 'rgba(245,166,35,0.15)' }} />

              {/* On payout you receive */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40 font-mono">On payout you receive</span>
                <motion.span
                  key={netPayout.toFixed(4)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="text-lg font-bold font-mono text-green-400"
                >
                  ${netPayout.toFixed(2)}
                </motion.span>
              </div>

              {/* Coverage */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40 font-mono">Coverage amount</span>
                <span className="text-lg font-bold font-mono text-white">${amount.toLocaleString()}</span>
              </div>

              {/* Period */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40 font-mono">Period</span>
                <span className="text-sm font-mono text-white/70">{period.label}</span>
              </div>

              {/* Network */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40 font-mono">Network</span>
                <span className="flex items-center gap-1.5 text-xs font-mono text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  {network.label} · Chain {network.chain}
                </span>
              </div>
            </div>
          </div>

          {/* CTA */}
          <Link href="/dashboard">
            <button className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors">
              <ArrowUpRight className="w-4 h-4" />
              Buy this policy — ${premium.toFixed(2)} {network.token}
            </button>
          </Link>
          <p className="text-xs text-white/20 text-center font-mono">Estimate only. Final premium set on-chain at purchase.</p>
        </div>
      </div>
    </motion.div>
  );
}

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
              <motion.div layoutId="glow" className="absolute inset-0 rounded-xl blur-xl opacity-20"
                style={{ background: step.color }} transition={{ duration: 0.35 }} />
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
              <motion.div animate={{ opacity: active > i ? 1 : 0.2, x: active > i ? 0 : -4 }} transition={{ duration: 0.3 }}>
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
    <motion.div {...fadeUp(0.15)} className="relative rounded-2xl border bg-card overflow-hidden"
      style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
      <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2">
          <ZeusLogoIcon size={22} />
          <span className="font-semibold text-white">Reserve Status</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />X Layer Mainnet
          </span>
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />BOT Chain Mainnet
          </span>
        </div>
      </div>
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
          <motion.div className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, #F5A623, #22c55e)' }}
            initial={{ width: 0 }} animate={{ width: `${pct}%` }}
            transition={{ duration: 1, delay: 0.5 }} />
        </div>
      </div>
      <div className="grid grid-cols-2">
        <div className="px-5 py-4 border-r" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-2">Daily Payout Limit</div>
          <div className="text-2xl font-bold text-white font-mono">$1,000</div>
          <div className="text-xs text-primary mt-1">Remaining today: $1,000</div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-2">Fund Reserve</div>
          <p className="text-xs text-white/50 leading-relaxed mb-3">Anyone can provide liquidity to protect AI agents from failed paid calls.</p>
          <Link href="/reserve">
            <button className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-mono text-white/70 hover:text-white transition-colors"
              style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.2)' }}>
              <span>Add USDC</span><ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </Link>
        </div>
      </div>
    </motion.div>
  );
}

/* ── How It Works steps ─────────────────────────────────────────────────── */
const HOW_STEPS = [
  { num: '01', icon: '🛡️', title: 'Insure', desc: 'Buy a policy via SDK or API. Choose coverage amount, timeout, and product type — Standard or Slashing Protection.', color: '#F5A623' },
  { num: '02', icon: '💸', title: 'Transact', desc: 'Your AI agent executes transactions freely. The policy covers losses from API failures or slashing events.', color: '#3b82f6' },
  { num: '03', icon: '🔍', title: 'Verify', desc: 'On-chain oracles monitor service delivery and validator behaviour. Evidence is cryptographically recorded.', color: '#a855f7' },
  { num: '04', icon: '⚡', title: 'Settle', desc: 'Automatic payout from the reserve fund in ~5 seconds. No disputes, no manual claims, no human required.', color: '#22c55e' },
];

/* ── Main Landing ───────────────────────────────────────────────────────── */
export default function Landing() {
  /* Parallax hero */
  const heroRef = useRef<HTMLElement>(null);
  const { scrollY } = useScroll();
  const bgY = useTransform(scrollY, [0, 600], [0, 120]);
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const bgYSpring = useSpring(bgY, { stiffness: 80, damping: 20 });

  return (
    <div className="overflow-hidden">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section ref={heroRef} className="relative min-h-screen flex items-center">
        {/* Parallax grid bg */}
        <motion.div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ y: bgYSpring }}>
          <div className="absolute inset-0 opacity-[0.025]"
            style={{ backgroundImage: `linear-gradient(rgba(245,166,35,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(245,166,35,0.6) 1px, transparent 1px)`, backgroundSize: '60px 60px' }} />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-primary/5 rounded-full blur-[140px]" />
          <div className="absolute bottom-0 right-1/4 w-[400px] h-[300px] bg-blue-500/3 rounded-full blur-[100px]" />
        </motion.div>

        <div className="relative w-full max-w-7xl mx-auto px-8 lg:px-12 py-24">
          <div className="grid grid-cols-2 gap-16 items-center">
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
                Trust Layer<br />for the<br /><span className="text-primary">Agentic Economy</span>
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
                    <ArrowUpRight className="w-4 h-4" />Open App
                  </button>
                </Link>
                <a href="https://github.com/igor-vii/Zeus-Insurance-Escrow" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-6 py-3 rounded-full font-mono text-sm text-white/70 hover:text-white transition-colors"
                  style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
                  View GitHub<ArrowRight className="w-4 h-4" />
                </a>
              </motion.div>

              {/* Metric chips */}
              <motion.div {...fadeUp(0.34)} className="flex items-center gap-3">
                {[
                  { label: 'PREMIUM', value: '7%+', sub: 'Risk-adjusted bps' },
                  { label: 'TOKEN', value: 'USDT', sub: 'BOT Chain · USDC on X Layer' },
                  { label: 'FLOW', value: 'x402', sub: 'Agent payments' },
                ].map((chip) => (
                  <div key={chip.label} className="px-5 py-3 rounded-xl"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="text-xs text-white/40 uppercase tracking-wider font-mono mb-1">{chip.label}</div>
                    <div className="text-lg font-bold text-white font-mono">{chip.value}</div>
                    <div className="text-xs text-white/35 mt-0.5">{chip.sub}</div>
                  </div>
                ))}
              </motion.div>
            </div>

            {/* Reserve card — slides in from right */}
            <motion.div {...slideIn('right', 0.1)}>
              <ReserveCard />
            </motion.div>
          </div>
        </div>

        {/* Scroll hint fades out */}
        <motion.div style={{ opacity: heroOpacity }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <span className="text-xs font-mono text-white/20 uppercase tracking-widest">Scroll</span>
          <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}>
            <ChevronRight className="w-4 h-4 text-white/20 rotate-90" />
          </motion.div>
        </motion.div>
      </section>

      {/* ── Partners ──────────────────────────────────────────────────────── */}
      <section className="py-10 border-t border-b" style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-white/25 uppercase tracking-widest shrink-0 mr-8">Ecosystem</span>
            <div className="flex items-center justify-around w-full gap-8">
              {['OKX', 'GSA', 'x402', 'BOT Chain'].map((name, i) => (
                <motion.div key={name} className="flex flex-col items-center gap-1 group cursor-default"
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}>
                  <div className="text-white/30 group-hover:text-white/70 transition-colors font-bold font-mono text-lg tracking-tight">{name}</div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── How It Works ──────────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="text-center mb-16" {...slideIn('up')}>
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

          {/* Connecting line */}
          <div className="relative">
            <motion.div
              className="absolute top-9 hidden lg:block h-px"
              style={{ left: '12.5%', right: '12.5%', background: 'linear-gradient(90deg, transparent, rgba(245,166,35,0.25), rgba(245,166,35,0.25), transparent)' }}
              initial={{ scaleX: 0, opacity: 0 }}
              whileInView={{ scaleX: 1, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
              {HOW_STEPS.map((step, i) => (
                <motion.div key={step.num}
                  className="relative flex flex-col items-center text-center p-6 rounded-2xl"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                  {...stagger(i)}>
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 text-2xl relative"
                    style={{ background: step.color + '15', border: `1px solid ${step.color}30` }}>
                    <span>{step.icon}</span>
                    <div className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono"
                      style={{ background: step.color, color: '#000' }}>{i + 1}</div>
                  </div>
                  <div className="text-xs font-mono uppercase tracking-widest mb-2" style={{ color: step.color }}>{step.num}</div>
                  <h3 className="text-lg font-bold text-white mb-2">{step.title}</h3>
                  <p className="text-sm text-white/40 leading-relaxed">{step.desc}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Flow Demo ─────────────────────────────────────────────────────── */}
      <section className="py-20 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="text-center mb-12" {...slideIn('up')}>
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
          <motion.div {...stagger(0)} className="max-w-2xl mx-auto">
            <div className="rounded-2xl p-8" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
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

      {/* ── Services ──────────────────────────────────────────────────────── */}
      <section className="py-20 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="mb-14" {...slideIn('left')}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">Our Services</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-3">Built for the Agent Economy</h2>
            <p className="text-white/40 text-sm max-w-lg">Every feature is designed to make M2M commerce safe and reliable on X Layer Mainnet and BOT Chain.</p>
          </motion.div>
          <div className="grid grid-cols-2 gap-5">
            {[
              { icon: Zap, tag: 'Insurance', title: 'Молниеносные выплаты', desc: 'Smart contracts detect API failures on-chain and automatically pay out from the reserve fund. No disputes, no delays — settlement in seconds.', stat: '~5s', statLabel: 'avg payout time' },
              { icon: Shield, tag: 'Escrow', title: 'Защищённая сделка', desc: 'ZeusEscrowBOT holds funds in smart contract escrow until service delivery is confirmed. Both parties are protected without a trusted third party.', stat: '100%', statLabel: 'non-custodial' },
              { icon: Eye, tag: 'Transparency', title: 'Fully Auditable On-Chain', desc: 'Every policy, premium, and payout is recorded on X Layer Mainnet (Chain 196) and BOT Chain (Chain 677). Fully auditable by anyone, forever.', stat: '677 · 196', statLabel: 'Chain IDs' },
              { icon: Cpu, tag: 'Agent-Native', title: 'x402 Protocol Integration', desc: 'AI agents buy and claim policies via REST API using the x402 payment protocol — zero human interaction required. MCP server included.', stat: 'REST + MCP', statLabel: 'agent APIs' },
            ].map(({ icon: Icon, tag, title, desc, stat, statLabel }, i) => (
              <motion.div key={title}
                className="group relative rounded-2xl p-7 hover:border-primary/30 transition-all duration-300 cursor-default"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                {...stagger(i)}>
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

      {/* ── Protocol stats — count-up ──────────────────────────────────────── */}
      <section className="py-16 border-t border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="grid grid-cols-4 gap-8">
            {[
              { to: 7, prefix: '', suffix: '%', decimals: 0, label: 'Premium rate', sub: 'Risk-adjusted bps' },
              { to: 1000, prefix: '$', suffix: '', decimals: 0, label: 'Daily payout cap', sub: 'Per reserve cycle' },
              { to: 93, prefix: '', suffix: '%', decimals: 0, label: 'Net refund rate', sub: 'After premium deduction' },
              { to: 677, prefix: '', suffix: '', decimals: 0, label: 'BOT Chain ID', sub: 'BOT Chain Mainnet' },
            ].map((s, i) => (
              <motion.div key={s.label} className="text-center" {...stagger(i)}>
                <div className="text-4xl font-bold text-primary font-mono mb-1">
                  <CountUp to={s.to} prefix={s.prefix} suffix={s.suffix} decimals={s.decimals} />
                </div>
                <div className="text-sm font-medium text-white mb-0.5">{s.label}</div>
                <div className="text-xs text-white/30">{s.sub}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Premium Calculator ────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div className="text-center mb-12" {...slideIn('up')}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-5">
              <Calculator className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-mono text-white/50 uppercase tracking-wider">Premium Calculator</span>
            </div>
            <h2 className="text-4xl font-bold text-white mb-3">
              Calculate your <span className="text-primary">policy cost</span>
            </h2>
            <p className="text-white/40 text-sm max-w-lg mx-auto">
              Set the coverage amount, pick a network and coverage type — see your premium and net payout instantly.
            </p>
          </motion.div>
          <PremiumCalculator />
        </div>
      </section>

      {/* ── Constitution Teaser ── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="text-center mb-16"
          >
            <h2 className="font-brand text-4xl md:text-5xl font-bold mb-6">
              Principles That <span className="text-primary">Endure</span>
            </h2>
            <p className="text-lg text-white/60 max-w-3xl mx-auto leading-relaxed">
              Technology evolves. Architectures change. But the foundational principles of trust, 
              transparency, and long-term thinking remain constant.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { article: 'I', title: 'Trust is Infrastructure', 
                excerpt: 'Trust is not a feature. Trust is infrastructure. It must be measurable, observable, auditable, composable.', delay: 0 },
              { article: 'II', title: 'Uncertainty Cannot Be Eliminated',
                excerpt: 'Every complex system fails. The purpose of Zeus is not to promise perfection, but to reduce the economic consequences of imperfection.', delay: 0.15 },
              { article: 'X', title: 'The Long View',
                excerpt: 'Success should be measured not only by adoption, but by usefulness. Zeus contributes to the institutional foundations of a sustainable autonomous AI economy.', delay: 0.3 }
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: item.delay, ease: [0.22, 1, 0.36, 1] }}
                className="relative group"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent rounded-2xl blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <div className="relative h-full p-8 rounded-2xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="font-mono text-xs text-primary/60 uppercase tracking-wider">Article</span>
                    <span className="font-brand text-5xl font-bold text-primary">{item.article}</span>
                  </div>
                  <h3 className="font-brand text-2xl font-bold mb-4 text-white">{item.title}</h3>
                  <p className="text-white/50 leading-relaxed text-sm mb-6">{item.excerpt}</p>
                  <Link href="/constitution">
                    <button className="flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                      Read Constitution
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </Link>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Developer SDK ─────────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="grid grid-cols-2 gap-16 items-center">
            <motion.div {...slideIn('left')}>
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
                {['1. Install: pnpm add @zeus-insurance/sdk', '2. Connect wallet + choose network', '3. Call createPolicy() — done'].map((step, i) => (
                  <motion.div key={i} className="flex items-center gap-3" {...stagger(i)}>
                    <div className="w-6 h-6 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <span className="text-sm font-mono text-white/60">{step}</span>
                  </motion.div>
                ))}
              </div>
              <div className="mt-8 flex items-center gap-3">
                <a href="https://github.com/igor-vii/Zeus-Insurance-Escrow" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors">
                  <ArrowUpRight className="w-4 h-4" />Examples on GitHub
                </a>
                <Link href="/docs">
                  <button className="flex items-center gap-2 px-5 py-2.5 rounded-full font-mono text-sm text-white/60 hover:text-white transition-colors"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
                    SDK Docs<ChevronRight className="w-4 h-4" />
                  </button>
                </Link>
              </div>
            </motion.div>

            {/* Code block */}
            <motion.div {...slideIn('right', 0.1)}>
              <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="flex items-center justify-between px-5 py-3"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)' }}>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
                  </div>
                  <span className="text-xs font-mono text-white/25">agent.ts</span>
                  <div />
                </div>
                <pre className="px-6 py-6 text-xs font-mono leading-6 overflow-x-auto" style={{ color: 'rgba(255,255,255,0.7)' }}>
{`import { ZeusSDK } from `}<span style={{ color: '#F5A623' }}>'@zeus-insurance/sdk'</span>{`;

`}<span style={{ color: '#60a5fa' }}>const</span>{` zeus = `}<span style={{ color: '#60a5fa' }}>new</span>{` `}<span style={{ color: '#22c55e' }}>ZeusSDK</span>{`({
  network: `}<span style={{ color: '#F5A623' }}>'bot-chain-mainnet'</span>{`,
  walletClient,
});

`}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// Standard insurance policy`}</span>{`
`}<span style={{ color: '#60a5fa' }}>const</span>{` policy = `}<span style={{ color: '#60a5fa' }}>await</span>{` zeus.insurance.`}<span style={{ color: '#22c55e' }}>createPolicy</span>{`({
  amount: `}<span style={{ color: '#a78bfa' }}>1_000_000n</span>{`,    `}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// 1 USDT`}</span>{`
  timeoutSeconds: `}<span style={{ color: '#a78bfa' }}>3600</span>{`,
});

`}<span style={{ color: 'rgba(255,255,255,0.25)' }}>{`// Slashing protection for validators`}</span>{`
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
            {...slideIn('up')}
          >
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-48 bg-primary/10 rounded-full blur-[80px]" />
            <div className="relative">
              <motion.div animate={{ rotate: [0, 5, -5, 0] }} transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }} className="inline-block mb-6">
                <ZeusLogoIcon size={44} />
              </motion.div>
              <h2 className="text-3xl font-bold text-white mb-3">Ready to Protect Your Payments?</h2>
              <p className="text-white/40 text-base mb-10 max-w-md mx-auto">
                Join the decentralized insurance protocol for AI agents. Live on X Layer Mainnet and BOT Chain now.
              </p>
              <div className="flex items-center gap-3 justify-center">
                <Link href="/dashboard">
                  <button className="flex items-center gap-2 px-7 py-3 rounded-full font-mono text-sm font-semibold bg-primary text-black hover:bg-primary/90 transition-colors">
                    <ArrowUpRight className="w-4 h-4" />Launch App
                  </button>
                </Link>
                <Link href="/docs">
                  <button className="flex items-center gap-2 px-7 py-3 rounded-full font-mono text-sm text-white/60 hover:text-white transition-colors"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
                    View Documentation<ChevronRight className="w-4 h-4" />
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
