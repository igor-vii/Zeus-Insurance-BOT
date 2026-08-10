import { useState, useEffect } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Constitution() {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/constitution.md')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load constitution');
        return res.text();
      })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const renderMarkdown = (md: string) => {
    const lines = md.split('\n');
    const elements: JSX.Element[] = [];
    let currentParagraph: string[] = [];

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const text = currentParagraph.join(' ');
        if (text.trim()) {
          const formatted = text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>');
          elements.push(
            <p key={elements.length} className="text-white/70 leading-relaxed mb-6" dangerouslySetInnerHTML={{ __html: formatted }} />
          );
        }
        currentParagraph = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line) {
        flushParagraph();
        continue;
      }

      if (line.startsWith('# ')) {
        flushParagraph();
        elements.push(
          <motion.h1
            key={elements.length}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: elements.length * 0.05 }}
            className="font-brand text-4xl md:text-5xl font-bold mb-8 mt-12 text-white"
          >
            {line.slice(2)}
          </motion.h1>
        );
      } else if (line.startsWith('## ')) {
        flushParagraph();
        elements.push(
          <motion.h2
            key={elements.length}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: elements.length * 0.05 }}
            className="font-brand text-3xl font-bold mb-6 mt-10 text-white"
          >
            {line.slice(3)}
          </motion.h2>
        );
      } else if (line.startsWith('### ')) {
        flushParagraph();
        elements.push(
          <motion.h3
            key={elements.length}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: elements.length * 0.05 }}
            className="font-brand text-2xl font-bold mb-4 mt-8 text-white"
          >
            {line.slice(4)}
          </motion.h3>
        );
      } else if (line.startsWith('---')) {
        flushParagraph();
        elements.push(
          <hr key={elements.length} className="my-12 border-white/10" />
        );
      } else {
        currentParagraph.push(line);
      }
    }

    flushParagraph();
    return elements;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-white/50 font-mono text-sm">Loading Constitution...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">Error: {error}</p>
          <Link href="/">
            <button className="px-6 py-3 bg-primary text-black rounded-full font-semibold hover:bg-primary/90 transition-colors">
              Back to Home
            </button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <section className="py-20 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-4xl mx-auto px-8 lg:px-12">
          <Link href="/">
            <motion.button
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4 }}
              className="flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors mb-8"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </motion.button>
          </Link>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="font-brand text-5xl md:text-6xl font-bold mb-6 text-white"
          >
            The Constitution of Zeus
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="text-xl text-white/60 leading-relaxed"
          >
            Foundational principles for the evolution of autonomous AI economic infrastructure
          </motion.p>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-4xl mx-auto px-8 lg:px-12">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            {renderMarkdown(content)}
          </motion.div>
        </div>
      </section>

      <section className="py-16 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="max-w-4xl mx-auto px-8 lg:px-12 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
          >
            <h2 className="font-brand text-3xl font-bold mb-6 text-white">Ready to Build?</h2>
            <p className="text-white/60 mb-8 text-lg">
              Put these principles into practice. Insure your AI agents today.
            </p>
            <Link href="/dashboard">
              <button className="px-8 py-4 bg-primary text-black rounded-full font-semibold text-lg hover:bg-primary/90 transition-colors">
                Open Dashboard
              </button>
            </Link>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
