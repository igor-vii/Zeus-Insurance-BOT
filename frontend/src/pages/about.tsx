import { Shield, Zap, Eye, Lock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ZeusLogoIcon } from '@/components/zeus-logo';

export default function About() {
  const { t } = useI18n();

  const values = [
    { icon: Eye, text: t.about.v1 },
    { icon: Zap, text: t.about.v2 },
    { icon: Shield, text: t.about.v3 },
    { icon: Lock, text: t.about.v4 },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
      {/* Header */}
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 mb-6">
          <span className="text-xs font-mono text-primary uppercase tracking-wider">{t.about.badge}</span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4">{t.about.title}</h1>
        <p className="text-xl text-muted-foreground">{t.about.subtitle}</p>
      </div>

      {/* Logo */}
      <div className="flex justify-center mb-16">
        <ZeusLogoIcon size={80} />
      </div>

      {/* Problem / Solution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        <div className="p-8 rounded-xl border border-red-900/30 bg-red-950/10">
          <div className="text-red-400 text-xs font-mono uppercase tracking-wider mb-3">⚠ {t.about.problem_title}</div>
          <p className="text-foreground/80 leading-relaxed">{t.about.problem_desc}</p>
        </div>
        <div className="p-8 rounded-xl border border-primary/30 bg-primary/5">
          <div className="text-primary text-xs font-mono uppercase tracking-wider mb-3">⚡ {t.about.solution_title}</div>
          <p className="text-foreground/80 leading-relaxed">{t.about.solution_desc}</p>
        </div>
      </div>

      {/* Mission & Vision */}
      <div className="space-y-6 mb-12">
        <div className="p-8 rounded-xl border border-border bg-card">
          <h2 className="text-lg font-semibold text-primary mb-3">{t.about.mission_title}</h2>
          <p className="text-xl font-medium text-foreground leading-relaxed italic">
            "{t.about.mission_desc}"
          </p>
        </div>
        <div className="p-8 rounded-xl border border-border bg-card">
          <h2 className="text-lg font-semibold text-primary mb-3">{t.about.vision_title}</h2>
          <p className="text-foreground/80 leading-relaxed">{t.about.vision_desc}</p>
        </div>
      </div>

      {/* Values */}
      <div>
        <h2 className="text-2xl font-bold mb-6 text-center">{t.about.values_title}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {values.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-start gap-4 p-5 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <p className="text-sm text-foreground/80 leading-relaxed pt-1.5">{text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Contract info */}
      <div className="mt-12 p-6 rounded-xl border border-border bg-card/50">
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-4">Deployed Contracts · X Layer Mainnet</h3>
        <div className="space-y-2">
          {[
            { name: 'ZeusInsuranceV2', addr: '0xE0b89E0DEa7Fc7AEa7CEcC62a0A14d52de42Ce3b' },
            { name: 'ZeusReserveV2', addr: '0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47' },
            { name: 'USDC', addr: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
          ].map(({ name, addr }) => (
            <div key={name} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
              <span className="text-xs text-primary font-mono font-semibold w-36 flex-shrink-0">{name}</span>
              <code className="text-xs text-muted-foreground font-mono break-all">{addr}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
