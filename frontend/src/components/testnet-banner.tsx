import { useState, useEffect } from 'react';
import { X, FlaskConical, ExternalLink } from 'lucide-react';

const STORAGE_KEY = 'zeus_testnet_banner_dismissed';

export function TestnetBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) setVisible(true);
  }, []);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="w-full bg-amber-950/60 border-b border-amber-700/40 px-4 py-2.5 flex items-start sm:items-center gap-3 text-sm">
      <FlaskConical className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5 sm:mt-0" />

      <p className="flex-1 text-amber-200/90 leading-snug">
        <span className="font-semibold text-amber-300">Тестовая сеть Base Sepolia.</span>{' '}
        Все транзакции бесплатны и не требуют реальных средств. Получить тестовые токены:{' '}
        <a
          href="https://faucet.circle.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-amber-100 transition-colors"
        >
          USDC (faucet.circle.com)
          <ExternalLink className="w-3 h-3 opacity-70" />
        </a>
        {' · '}
        <a
          href="https://coinbase.com/faucets/base-ethereum-sepolia-faucet"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-amber-100 transition-colors"
        >
          ETH (Coinbase Faucet)
          <ExternalLink className="w-3 h-3 opacity-70" />
        </a>
      </p>

      <button
        onClick={dismiss}
        aria-label="Закрыть"
        className="flex-shrink-0 p-1 rounded hover:bg-amber-800/40 text-amber-400 hover:text-amber-200 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
