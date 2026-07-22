import { ExternalLink, Github, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      {label && (
        <div className="flex items-center justify-between px-4 py-2 bg-secondary/50 border-b border-border">
          <span className="text-xs font-mono text-muted-foreground">{label}</span>
          <button onClick={copy} className="text-muted-foreground hover:text-foreground transition-colors">
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
      <pre className="p-4 text-xs font-mono text-foreground/80 overflow-x-auto bg-black/20 leading-relaxed whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

export default function Docs() {
  const { t } = useI18n();

  const steps = [
    { n: '01', title: t.docs.step1_title, desc: t.docs.step1_desc },
    { n: '02', title: t.docs.step2_title, desc: t.docs.step2_desc },
    { n: '03', title: t.docs.step3_title, desc: t.docs.step3_desc },
    { n: '04', title: t.docs.step4_title, desc: t.docs.step4_desc },
    { n: '05', title: t.docs.step5_title, desc: t.docs.step5_desc },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
      {/* Header */}
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 mb-6">
          <span className="text-xs font-mono text-primary uppercase tracking-wider">{t.docs.badge}</span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4">{t.docs.title}</h1>
        <p className="text-xl text-muted-foreground">{t.docs.subtitle}</p>
      </div>

      {/* Quick start */}
      <div className="mb-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">{t.docs.guide_title}</h2>
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-primary/10 text-primary border border-primary/20">
            ⏱ {t.docs.guide_badge}
          </span>
        </div>

        <div className="space-y-4">
          {steps.map(({ n, title, desc }) => (
            <div key={n} className="flex gap-5 p-5 rounded-xl border border-border bg-card hover:border-primary/20 transition-colors">
              <div className="text-2xl font-bold text-primary/30 font-mono leading-none flex-shrink-0 w-8">{n}</div>
              <div>
                <h3 className="font-semibold text-foreground mb-1">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Contracts */}
      <div className="mb-12">
        <h2 className="text-2xl font-bold mb-3">{t.docs.contracts_title}</h2>
        <p className="text-muted-foreground mb-5">{t.docs.contracts_desc}</p>
        <div className="space-y-3">
          {[
            { name: 'ZeusInsuranceV2', addr: '0xE0b89E0DEa7Fc7AEa7CEcC62a0A14d52de42Ce3b', label: 'Main insurance contract' },
            { name: 'ZeusReserveV2', addr: '0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47', label: 'Reserve fund contract' },
            { name: 'USDC (X Layer Mainnet)', addr: '0x74b7F16337b8972027F6196A17a631aC6dE26d22', label: 'USDC token on X Layer' },
          ].map(({ name, addr, label }) => (
            <div key={name} className="flex flex-col sm:flex-row sm:items-center gap-2 p-4 rounded-lg border border-border bg-card/50">
              <div className="sm:w-52 flex-shrink-0">
                <div className="text-sm font-semibold text-foreground">{name}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
              <code className="text-xs font-mono text-primary break-all">{addr}</code>
            </div>
          ))}
        </div>
      </div>

      {/* API */}
      <div className="mb-12">
        <h2 className="text-2xl font-bold mb-3">{t.docs.api_title}</h2>
        <p className="text-muted-foreground mb-5">{t.docs.api_desc}</p>

        <div className="space-y-4">
          <CodeBlock
            label="GET /api/quote"
            code={`curl "http://localhost:8080/api/quote?amount=100000000&maxRetries=3"
# → {"premiumBps":1100,"premiumAmount":"11000000","totalCost":"11000000"}`}
          />
          <CodeBlock
            label="POST /api/prepare-buy"
            code={`curl -X POST http://localhost:8080/api/prepare-buy \\
  -H "Content-Type: application/json" \\
  -d '{"seller":"0xSELLER","amount":"100000000","timeoutSeconds":86400,"maxRetries":1}'
# → {"to":"0xE0b89E...","data":"0x...","premiumAmount":"7000000"}`}
          />
          <CodeBlock
            label="GET /api/policies"
            code={`curl "http://localhost:8080/api/policies?buyer=0xYOUR_ADDRESS"
# → [{"id":"1","amount":"100000000","status":"active",...}]`}
          />
        </div>
      </div>

      {/* GitHub */}
      <div className="p-8 rounded-2xl border border-primary/20 bg-primary/5 text-center">
        <Github className="w-10 h-10 text-primary mx-auto mb-4" />
        <h3 className="text-xl font-semibold mb-3">{t.docs.github_btn}</h3>
        <a
          href="https://github.com/igor-vii/Zeus-insurance-v2.1"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button className="font-mono uppercase tracking-wider gap-2 text-sm">
            <Github className="w-4 h-4" />
            github.com/igor-vii/Zeus-insurance-v2.1
            <ExternalLink className="w-3.5 h-3.5 opacity-70" />
          </Button>
        </a>
      </div>
    </div>
  );
}
