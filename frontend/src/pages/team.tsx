import { ExternalLink, Github, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { ZeusLogoIcon } from '@/components/zeus-logo';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay },
});

export default function Team() {
  const { t, lang } = useI18n();

  const isRu = lang === 'ru';

  const introText = isRu
    ? 'Проект создан разработчиком-энтузиастом, который верит в будущее AI-агентов и децентрализованных финансов.'
    : 'The project was built by an enthusiast developer who believes in the future of AI agents and decentralized finance.';

  const founderDesc = isRu
    ? 'Занимаюсь Web3-разработкой, смарт-контрактами и децентрализованными протоколами. Убеждён, что будущее за автономными агентами и безопасными M2M-платежами.'
    : 'I work on Web3 development, smart contracts, and decentralized protocols. I believe the future belongs to autonomous agents and secure M2M payments.';

  const joinDesc = isRu
    ? 'Проект открыт для сотрудничества. Если вы разработчик, дизайнер или просто энтузиаст — присоединяйтесь!'
    : 'The project is open for collaboration. If you\'re a developer, designer, or just an enthusiast — join us!';

  const joinTitle = isRu ? 'Открыты для сотрудничества' : 'Open for Collaboration';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
      {/* Header */}
      <motion.div {...fadeUp(0)} className="text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 mb-6">
          <span className="text-xs font-mono text-primary uppercase tracking-wider">{t.team.badge}</span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4">
          {isRu ? 'Команда Zeus Insurance' : t.team.title}
        </h1>
      </motion.div>

      {/* Intro paragraph */}
      <motion.p {...fadeUp(0.08)} className="text-xl text-muted-foreground text-center mb-14 max-w-2xl mx-auto leading-relaxed">
        {introText}
      </motion.p>

      {/* Founder card */}
      <motion.div {...fadeUp(0.15)} className="mb-10">
        <div className="p-8 rounded-2xl border border-primary/20 bg-card relative overflow-hidden">
          {/* Animated glow — only behind card, not obstructing text */}
          <motion.div
            className="absolute -top-16 -right-16 w-48 h-48 bg-primary/8 rounded-full blur-[50px] pointer-events-none"
            animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.9, 0.5] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
          />

          <div className="relative flex flex-col sm:flex-row gap-6 items-start">
            {/* Avatar */}
            <motion.div
              className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0"
              whileHover={{ scale: 1.05 }}
              transition={{ duration: 0.2 }}
            >
              <ZeusLogoIcon size={40} />
            </motion.div>

            {/* Info */}
            <div className="flex-1">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
                <h2 className="text-2xl font-bold">Игорь Иванов</h2>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono bg-primary/10 text-primary border border-primary/20">
                  {isRu ? 'Основатель и разработчик' : t.team.founder_role}
                </span>
              </div>

              <p className="text-foreground/80 leading-relaxed mb-5">{founderDesc}</p>

              <div className="flex flex-wrap gap-3">
                <a href="https://github.com/igor-vii" target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2 font-mono text-xs border-border hover:border-primary/50">
                    <Github className="w-3.5 h-3.5" />
                    {t.team.github_btn}
                    <ExternalLink className="w-3 h-3 opacity-50" />
                  </Button>
                </a>
                <a href="https://t.me/IvanovVII" target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2 font-mono text-xs border-border hover:border-primary/50">
                    Telegram
                    <ExternalLink className="w-3 h-3 opacity-50" />
                  </Button>
                </a>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Join / collaborate */}
      <motion.div {...fadeUp(0.22)} className="p-8 rounded-2xl border border-border bg-card/50 text-center mb-12">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Users className="w-6 h-6 text-primary" />
        </div>
        <h3 className="text-xl font-semibold mb-3">{joinTitle}</h3>
        <p className="text-muted-foreground mb-6 max-w-lg mx-auto leading-relaxed">{joinDesc}</p>
        <a href="https://github.com/igor-vii/Zeus-insurance-v2.1" target="_blank" rel="noopener noreferrer">
          <Button className="font-mono uppercase tracking-wider gap-2 text-sm">
            <Github className="w-4 h-4" />
            {t.team.join_btn}
            <ExternalLink className="w-3.5 h-3.5 opacity-70" />
          </Button>
        </a>
      </motion.div>

      {/* Tech stack */}
      <motion.div {...fadeUp(0.3)} className="p-6 rounded-xl border border-border bg-card/30">
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-4 text-center">Tech Stack</h3>
        <div className="flex flex-wrap gap-2 justify-center">
          {['Solidity', 'TypeScript', 'React 19', 'Vite', 'wagmi v3', 'viem v2', 'Base Sepolia', 'Hardhat', 'OpenZeppelin', 'Drizzle ORM', 'Express 5', 'TailwindCSS'].map((tech) => (
            <span key={tech} className="px-3 py-1 rounded-full text-xs font-mono bg-secondary/50 text-muted-foreground border border-border">
              {tech}
            </span>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
