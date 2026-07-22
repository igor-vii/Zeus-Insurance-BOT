import { Link, useLocation } from 'wouter';
import { useState } from 'react';
import { Globe, ArrowUpRight, ExternalLink } from 'lucide-react';
import { ZeusLogo } from '@/components/zeus-logo';
import { useI18n, LANG_LABELS, LANG_NAMES, Lang } from '@/lib/i18n';
import { cn } from '@/lib/utils';

function LangSwitcher() {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const langs = Object.keys(LANG_LABELS) as Lang[];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-mono text-white/50 hover:text-white hover:bg-white/5 transition-colors"
        style={{ border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <Globe className="w-3.5 h-3.5" />
        <span>{LANG_LABELS[lang]}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 rounded-xl shadow-xl overflow-hidden min-w-[140px]"
            style={{ background: 'hsl(222 47% 8%)', border: '1px solid rgba(255,255,255,0.1)' }}>
            {langs.map((l) => (
              <button
                key={l}
                onClick={() => { setLang(l); setOpen(false); }}
                className={cn(
                  'w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left',
                  l === lang ? 'text-primary font-medium' : 'text-white/50'
                )}
              >
                <span>{LANG_NAMES[l]}</span>
                <span className="font-mono text-xs opacity-60">{LANG_LABELS[l]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { t, isRTL } = useI18n();
  const [location] = useLocation();

  const navLinks = [
    { href: '/reserve', label: 'Reserve' },
    { href: '/about', label: 'Protocol' },
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/escrow', label: 'Escrow' },
    { href: '/docs', label: 'Docs' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-50 backdrop-blur-md" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(8,12,20,0.85)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12">
          <div className="flex items-center justify-between h-[60px]">
            {/* Logo */}
            <Link href="/">
              <ZeusLogo size={26} textSize="text-base" className="cursor-pointer hover:opacity-80 transition-opacity" />
            </Link>

            {/* Nav links */}
            <nav className="flex items-center gap-1">
              {navLinks.map((link) => {
                const isActive = location === link.href;
                return (
                  <Link key={link.href} href={link.href}>
                    <span className={cn(
                      'px-4 py-1.5 rounded-full text-sm font-medium transition-colors cursor-pointer',
                      isActive
                        ? 'text-white bg-white/8'
                        : 'text-white/50 hover:text-white hover:bg-white/5'
                    )}>
                      {link.label}
                    </span>
                  </Link>
                );
              })}
            </nav>

            {/* Right side */}
            <div className="flex items-center gap-2">
              <LangSwitcher />
              <Link href="/dashboard">
                <button className="flex items-center gap-1.5 px-4 py-2 rounded-full font-mono text-sm font-semibold text-black bg-primary hover:bg-primary/90 transition-colors">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Open app
                </button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main>{children}</main>

      {/* ── Footer ── */}
      <footer className="mt-8" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
        <div className="max-w-7xl mx-auto px-8 lg:px-12 py-10">
          <div className="flex items-center justify-between">
            {/* Left: logo + links */}
            <div className="flex items-center gap-10">
              <Link href="/">
                <ZeusLogo size={24} textSize="text-sm" className="cursor-pointer hover:opacity-80 transition-opacity" />
              </Link>
              <nav className="flex items-center gap-6">
                {[
                  { href: '/dashboard', label: 'Insurance' },
                  { href: '/reserve', label: 'Reserve' },
                  { href: '/escrow', label: 'Escrow' },
                  { href: '/dashboard', label: 'Dashboard' },
                  { href: '/docs', label: 'Docs' },
                  { href: '/about', label: 'About' },
                ].map((l) => (
                  <Link key={l.label + l.href} href={l.href}>
                    <span className="text-sm text-white/35 hover:text-white/70 transition-colors cursor-pointer">{l.label}</span>
                  </Link>
                ))}
                {[
                  { href: 'https://t.me/IvanovVII', label: 'Telegram' },
                  { href: 'https://github.com/igor-vii/Zeus-Insurance-Escrow', label: 'GitHub' },
                ].map((l) => (
                  <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-white/35 hover:text-primary transition-colors">
                    {l.label}
                    <ExternalLink className="w-2.5 h-2.5 opacity-50" />
                  </a>
                ))}
              </nav>
            </div>

            {/* Right: CTA + chain badge */}
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono text-white/25">X Layer Mainnet · Chain 196</span>
              <Link href="/dashboard">
                <button className="flex items-center gap-1.5 px-4 py-2 rounded-full font-mono text-sm font-semibold text-black bg-primary hover:bg-primary/90 transition-colors">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Open app
                </button>
              </Link>
            </div>
          </div>

          <div className="mt-8 pt-6 flex items-center justify-between" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="text-xs text-white/20">© 2025 Zeus Insurance. All rights reserved.</p>
            <a href="https://www.netlify.com" target="_blank" rel="noreferrer"
              className="text-xs text-white/20 hover:text-white/50 transition-colors">
              This site is powered by Netlify
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
