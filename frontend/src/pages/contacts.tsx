import { ExternalLink, Send, Mail, Github } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export default function Contacts() {
  const { t } = useI18n();

  const contacts = [
    {
      icon: Send,
      label: t.contacts.telegram_label,
      value: '@IvanovVII',
      href: 'https://t.me/IvanovVII',
      color: 'text-blue-400',
      bg: 'bg-blue-400/10 border-blue-400/20',
    },
    {
      icon: Mail,
      label: t.contacts.email_label,
      value: 'zeusinsurance@mail.ru',
      href: 'mailto:zeusinsurance@mail.ru',
      color: 'text-green-400',
      bg: 'bg-green-400/10 border-green-400/20',
    },
    {
      icon: Github,
      label: t.contacts.github_label,
      value: 'github.com/igor-vii/Zeus-insurance-v2.1',
      href: 'https://github.com/igor-vii/Zeus-insurance-v2.1',
      color: 'text-primary',
      bg: 'bg-primary/10 border-primary/20',
    },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
      {/* Header */}
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 mb-6">
          <span className="text-xs font-mono text-primary uppercase tracking-wider">{t.contacts.badge}</span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4">{t.contacts.title}</h1>
        <p className="text-xl text-muted-foreground">{t.contacts.subtitle}</p>
      </div>

      {/* Contact cards */}
      <div className="space-y-4 mb-10">
        {contacts.map(({ icon: Icon, label, value, href, color, bg }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-5 p-6 rounded-2xl border border-border bg-card hover:border-primary/30 hover:bg-primary/[0.02] transition-all duration-200"
          >
            <div className={`w-12 h-12 rounded-xl ${bg} border flex items-center justify-center flex-shrink-0`}>
              <Icon className={`w-5 h-5 ${color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">{label}</div>
              <div className="text-foreground font-medium truncate">{value}</div>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          </a>
        ))}
      </div>

      {/* Response time info */}
      <div className="p-6 rounded-xl border border-border bg-card/50 text-center">
        <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse mx-auto mb-3" />
        <h3 className="font-semibold mb-2">{t.contacts.response_title}</h3>
        <p className="text-sm text-muted-foreground">{t.contacts.response_desc}</p>
      </div>

      {/* Bottom note */}
      <div className="mt-10 text-center text-sm text-muted-foreground">
        <p>Zeus Insurance · Base Sepolia · Chain ID 84532</p>
        <p className="mt-1 text-xs opacity-60">Open source · MIT License</p>
      </div>
    </div>
  );
}
