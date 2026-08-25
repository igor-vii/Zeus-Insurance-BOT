import { useState, useEffect } from 'react';
import { X, Zap } from 'lucide-react';
import { useChainId } from 'wagmi';
import { SUPPORTED_CHAINS } from '@/lib/wagmi';

const STORAGE_KEY = 'zeus_network_banner_dismissed_v2';

export function TestnetBanner() {
  const [visible, setVisible] = useState(false);
  const chainId = useChainId();

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) setVisible(true);
  }, []);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
  }

  if (!visible) return null;

  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const networkName = chain?.name ?? 'BOT Chain Mainnet';
  const isBotChain = chainId === 677;

  return (
    <div className="w-full bg-primary/10 border-b border-primary/30 px-4 py-2.5 flex items-start sm:items-center gap-3 text-sm">
      <Zap className="w-4 h-4 text-primary flex-shrink-0 mt-0.5 sm:mt-0" />

      <p className="flex-1 text-foreground/80 leading-snug">
        <span className="font-semibold text-primary">{networkName}.</span>{' '}
        Для работы с протоколом необходим{' '}
        <span className="font-medium">USDT</span>{' '}
        {isBotChain ? 'на BOT Chain (chain 677)' : 'на X Layer (chain 196)'}.
        {' '}Убедитесь, что ваш кошелёк подключён к правильной сети.
      </p>

      <button
        onClick={dismiss}
        aria-label="Закрыть"
        className="flex-shrink-0 p-1 rounded hover:bg-primary/20 text-primary/70 hover:text-primary transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
