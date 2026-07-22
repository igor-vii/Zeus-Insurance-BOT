// Zeus Insurance — OKX Fund Pitch Deck Generator
// Run: node scripts/generate-pitch-deck.cjs

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'Zeus_Insurance_Pitch_Deck.pdf');

// ── Palette ──────────────────────────────────────────────────────────────────
const BG       = '#080c14';
const GOLD     = '#F5A623';
const WHITE    = '#FFFFFF';
const WHITE60  = '#99A8BF';
const WHITE15  = '#1E2B3D';
const WHITE08  = '#111820';
const GREEN    = '#22C55E';
const RED      = '#EF4444';

const W = 841.89;  // A4 landscape width  (pts)
const H = 595.28;  // A4 landscape height

// ── Helpers ──────────────────────────────────────────────────────────────────
function bg(doc, color = BG) {
  doc.rect(0, 0, W, H).fill(color);
}

function grid(doc) {
  doc.save();
  doc.opacity(0.025);
  const step = 45;
  doc.strokeColor(GOLD).lineWidth(0.5);
  for (let x = 0; x < W; x += step) doc.moveTo(x, 0).lineTo(x, H).stroke();
  for (let y = 0; y < H; y += step) doc.moveTo(0, y).lineTo(W, y).stroke();
  doc.restore();
}

// Zeus shield drawn with pdfkit primitives
function zeusShield(doc, x, y, size = 80) {
  const s = size / 80;
  doc.save();
  doc.translate(x, y);

  // Shield body
  doc.save();
  doc.strokeColor(GOLD).lineWidth(2.5 * s).fillColor('#0f1623');
  doc.moveTo(40 * s, 2 * s)
    .lineTo(78 * s, 10 * s)
    .lineTo(78 * s, 28 * s)
    .bezierCurveTo(78 * s, 46 * s, 62 * s, 58 * s, 40 * s, 64 * s)
    .bezierCurveTo(18 * s, 58 * s, 2 * s, 46 * s, 2 * s, 28 * s)
    .lineTo(2 * s, 10 * s)
    .closePath()
    .fillAndStroke();
  doc.restore();

  // Inner glow
  doc.save();
  doc.opacity(0.07).fillColor(GOLD);
  doc.moveTo(40 * s, 7 * s)
    .lineTo(72 * s, 14 * s)
    .lineTo(72 * s, 28 * s)
    .bezierCurveTo(72 * s, 43 * s, 58 * s, 54 * s, 40 * s, 59 * s)
    .bezierCurveTo(22 * s, 54 * s, 8 * s, 43 * s, 8 * s, 28 * s)
    .lineTo(8 * s, 14 * s)
    .closePath()
    .fill();
  doc.restore();

  // Lightning bolt Z-shape
  doc.save();
  doc.fillColor(GOLD).strokeColor(GOLD).lineWidth(0.5 * s);
  doc.moveTo(48 * s, 13 * s)
    .lineTo(30 * s, 13 * s)
    .lineTo(26 * s, 31 * s)
    .lineTo(38 * s, 31 * s)
    .lineTo(32 * s, 50 * s)
    .lineTo(54 * s, 27 * s)
    .lineTo(42 * s, 27 * s)
    .closePath()
    .fillAndStroke();
  doc.restore();

  doc.restore();
}

function goldBar(doc, x, y, w, h = 3) {
  doc.rect(x, y, w, h).fill(GOLD);
}

function badge(doc, x, y, text, color = GOLD) {
  const tw = doc.widthOfString(text, { fontSize: 8 }) + 24;
  doc.roundedRect(x, y, tw, 22, 11)
    .fill(color + '1A')
    .stroke(color + '50');
  doc.fontSize(8).fillColor(color).font('Helvetica-Bold')
    .text(text, x + 12, y + 7, { width: tw - 20, lineBreak: false });
  return tw;
}

function card(doc, x, y, w, h, opts = {}) {
  const { fill = WHITE15, stroke = WHITE08, radius = 10 } = opts;
  doc.roundedRect(x, y, w, h, radius).fill(fill);
  if (stroke) doc.roundedRect(x, y, w, h, radius).stroke(stroke);
}

function bulletLine(doc, x, y, text, color, lineW) {
  doc.fontSize(10).fillColor(color).font('Helvetica')
    .text('> ' + text, x, y, { width: lineW });
}

function footerLine(doc, pageNum) {
  zeusShield(doc, W - 60, H - 56, 38);
  doc.fontSize(8).fillColor(WHITE60).font('Helvetica')
    .text('Zeus Insurance Protocol  ·  OKX Fund Pitch', 36, H - 28, { width: W - 120 });
  doc.fontSize(8).fillColor(WHITE60).font('Helvetica')
    .text(pageNum + ' / 6', W - 60, H - 28, { width: 40, align: 'right' });
}

// ── SLIDE 1 — Title ──────────────────────────────────────────────────────────
function slide1(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  // Glow behind shield
  doc.save();
  doc.circle(W / 2, H / 2, 160).fill(GOLD + '0D');
  doc.circle(W / 2, H / 2, 100).fill(GOLD + '18');
  doc.restore();

  zeusShield(doc, W / 2 - 90, H / 2 - 120, 180);

  doc.fontSize(52).fillColor(GOLD).font('Helvetica-Bold')
    .text('ZEUS', 0, H / 2 + 75, { align: 'center', width: W });

  doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold')
    .text('Insurance Protocol', 0, H / 2 + 132, { align: 'center', width: W });

  doc.fontSize(14).fillColor(WHITE60).font('Helvetica')
    .text('Trust Layer for the Agentic Economy', 0, H / 2 + 162, { align: 'center', width: W });

  goldBar(doc, W / 2 - 100, H / 2 + 195, 200);

  doc.fontSize(11).fillColor(WHITE60).font('Helvetica')
    .text('Decentralized insurance and escrow for AI agents.', 0, H / 2 + 210, { align: 'center', width: W });

  badge(doc, 36, H - 50, 'X Layer Mainnet  |  Chain 196', GREEN);

  zeusShield(doc, W - 60, 10, 42);
}

// ── SLIDE 2 — Problem & Solution ─────────────────────────────────────────────
function slide2(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  badge(doc, 36, 30, 'THE PROBLEM & SOLUTION');
  doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold')
    .text('AI Agents Lose Millions on', 36, 62, { width: W - 72 });
  doc.fontSize(28).fillColor(GOLD).font('Helvetica-Bold')
    .text('Failed API Calls.', 36, 96, { width: W - 72 });
  goldBar(doc, 36, 133, 420, 2);

  const colW = (W - 72 - 32) / 2;
  const leftX = 36;
  const rightX = leftX + colW + 32;
  const topY = 150;

  // LEFT — Problem
  card(doc, leftX, topY, colW, H - topY - 50, { fill: RED + '0D', stroke: RED + '30' });
  doc.fontSize(13).fillColor(RED).font('Helvetica-Bold')
    .text('The Problem', leftX + 20, topY + 20);
  goldBar(doc, leftX + 20, topY + 42, 60, 2);

  const problems = [
    'API does not respond — funds already debited.',
    'Refunds require trust and take days.',
    'No standard way to insure a transaction.',
    'AI agents operate autonomously — no human recourse.',
    'Every failed call = lost revenue for the agent.',
  ];
  problems.forEach((text, i) => {
    bulletLine(doc, leftX + 20, topY + 58 + i * 52, text, '#FFAAAA', colW - 40);
  });

  // RIGHT — Solution
  card(doc, rightX, topY, colW, H - topY - 50, { fill: GOLD + '0D', stroke: GOLD + '30' });
  doc.fontSize(13).fillColor(GOLD).font('Helvetica-Bold')
    .text('The Zeus Solution', rightX + 20, topY + 20);
  goldBar(doc, rightX + 20, topY + 42, 60, 2);

  const solutions = [
    'Automatic insurance & escrow on-chain.',
    'Instant payouts from the reserve fund.',
    'Integrate in 3 steps via SDK or REST API.',
    'Fully autonomous — agents need no human.',
    'Non-custodial, trustless, fully auditable.',
  ];
  solutions.forEach((text, i) => {
    bulletLine(doc, rightX + 20, topY + 58 + i * 52, text, '#FFE0A0', colW - 40);
  });

  footerLine(doc, 2);
}

// ── SLIDE 3 — How It Works ────────────────────────────────────────────────────
function slide3(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  badge(doc, 36, 30, 'HOW IT WORKS');
  doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold')
    .text('Automatic Protection', 36, 62, { width: 480 });
  doc.fontSize(28).fillColor(GOLD).font('Helvetica-Bold')
    .text('in Action.', 36, 96, { width: 480 });
  goldBar(doc, 36, 133, 300, 2);

  const flowY = 160;
  const cardW = 195;
  const gap = 44;
  const totalW = 3 * cardW + 2 * gap;
  const startX = (W - totalW) / 2;

  const steps = [
    { label: 'AGENT PAYS',   value: '$1.00',    sub: 'via x402 protocol',  color: GOLD,  bg: GOLD  + '18', tag: '[ 1 ]' },
    { label: 'API FAILS',    value: 'Detected', sub: 'on-chain oracle',    color: RED,   bg: RED   + '18', tag: '[ 2 ]' },
    { label: 'ZEUS REFUNDS', value: '$0.93',    sub: 'in ~5 seconds',      color: GREEN, bg: GREEN + '18', tag: '[ 3 ]' },
  ];

  steps.forEach((s, i) => {
    const cx = startX + i * (cardW + gap);
    doc.roundedRect(cx, flowY, cardW, 175, 12).fill(s.bg);
    doc.roundedRect(cx, flowY, cardW, 175, 12).stroke(s.color + '60');

    // Step number tag
    doc.fontSize(10).fillColor(s.color).font('Helvetica-Bold')
      .text(s.tag, cx + 10, flowY + 14, { width: cardW - 20, align: 'center' });

    // Label
    doc.fontSize(9).fillColor(s.color).font('Helvetica-Bold')
      .text(s.label, cx + 10, flowY + 50, { width: cardW - 20, align: 'center' });

    // Value
    doc.fontSize(30).fillColor(s.color).font('Helvetica-Bold')
      .text(s.value, cx + 10, flowY + 72, { width: cardW - 20, align: 'center' });

    // Sub
    doc.fontSize(9).fillColor(WHITE60).font('Helvetica')
      .text(s.sub, cx + 10, flowY + 130, { width: cardW - 20, align: 'center' });

    // Arrow
    if (i < 2) {
      const ax = cx + cardW + 8;
      const ay = flowY + 87;
      doc.save();
      doc.strokeColor(WHITE60).lineWidth(1.5)
        .moveTo(ax, ay).lineTo(ax + gap - 16, ay).stroke();
      doc.fillColor(WHITE60)
        .moveTo(ax + gap - 16, ay - 5)
        .lineTo(ax + gap - 8, ay)
        .lineTo(ax + gap - 16, ay + 5)
        .fill();
      doc.restore();
    }
  });

  // Detail breakdown
  const bY = flowY + 195;
  card(doc, startX, bY, totalW, 100, { fill: WHITE08, stroke: WHITE15 });

  const details = [
    { label: 'Premium paid',    value: '$0.07', note: '7% of insured amount' },
    { label: 'Amount insured',  value: '$1.00', note: 'USDC on X Layer' },
    { label: 'Refund received', value: '$0.93', note: 'Net of premium  |  ~5 sec' },
  ];
  const detW = totalW / 3;
  details.forEach((d, i) => {
    const dx = startX + i * detW;
    if (i > 0) doc.save().strokeColor(WHITE15).lineWidth(1).moveTo(dx, bY + 16).lineTo(dx, bY + 84).stroke().restore();
    doc.fontSize(8).fillColor(WHITE60).font('Helvetica').text(d.label.toUpperCase(), dx, bY + 16, { width: detW, align: 'center' });
    doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text(d.value, dx, bY + 36, { width: detW, align: 'center' });
    doc.fontSize(8).fillColor(WHITE60).font('Helvetica').text(d.note, dx, bY + 68, { width: detW, align: 'center' });
  });

  doc.fontSize(11).fillColor(WHITE60).font('Helvetica')
    .text('"Agent pays $1.00. API fails. Zeus automatically refunds $0.93 to the agent wallet."',
      36, H - 52, { width: W - 72, align: 'center' });

  footerLine(doc, 3);
}

// ── SLIDE 4 — Products ────────────────────────────────────────────────────────
function slide4(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  badge(doc, 36, 30, 'OUR PRODUCTS');
  doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold').text('Two Products,', 36, 62, { width: 480 });
  doc.fontSize(28).fillColor(GOLD).font('Helvetica-Bold').text('One Trust Layer.', 36, 96, { width: 480 });
  goldBar(doc, 36, 133, 300, 2);

  const topY = 152;
  const colW = (W - 72 - 24) / 2;
  const lX = 36;
  const rX = lX + colW + 24;
  const cH = H - topY - 46;

  // ── LEFT: Escrow ──
  card(doc, lX, topY, colW, cH, { fill: WHITE15, stroke: WHITE08 });
  badge(doc, lX + 16, topY + 16, 'MODEL A  —  ESCROW');
  doc.fontSize(16).fillColor(WHITE).font('Helvetica-Bold').text('Protected Transaction', lX + 16, topY + 48, { width: colW - 32 });
  goldBar(doc, lX + 16, topY + 74, 80, 2);

  const escrowItems = [
    'Funds locked until delivery is confirmed.',
    '0.7% + $0.02 flat fee per transaction.',
    'Full deposit refund on timeout.',
    'Automated release via on-chain oracle.',
    'Full audit trail on X Layer Mainnet.',
  ];
  escrowItems.forEach((text, i) => {
    bulletLine(doc, lX + 20, topY + 90 + i * 44, text, WHITE60, colW - 44);
  });

  doc.roundedRect(lX + 16, topY + cH - 62, colW - 32, 44, 8).fill(GOLD + '1A').stroke(GOLD + '40');
  doc.fontSize(10).fillColor(GOLD).font('Helvetica-Bold')
    .text('Commission: 0.7% + $0.02 per tx   |   Non-custodial', lX + 24, topY + cH - 46, { width: colW - 48 });

  // ── RIGHT: Insurance ──
  card(doc, rX, topY, colW, cH, { fill: WHITE15, stroke: WHITE08 });
  badge(doc, rX + 16, topY + 16, 'MODEL B  —  INSURANCE', GOLD);
  doc.fontSize(16).fillColor(WHITE).font('Helvetica-Bold').text('Smart Coverage Suite', rX + 16, topY + 48, { width: colW - 32 });
  goldBar(doc, rX + 16, topY + 74, 80, 2);

  // ── All-inclusive Insurance
  let iy = topY + 90;
  doc.fontSize(11).fillColor(GOLD).font('Helvetica-Bold').text('All-inclusive Insurance', rX + 16, iy, { width: colW - 32 });
  iy += 18;
  const aiItems = [
    'Covers API failures, network errors, wallet limits,',
    'gas shortages, MCP errors.',
    'Dynamic premium based on Risk Score.',
    'Instant payouts from reserve.',
  ];
  aiItems.forEach(line => {
    doc.fontSize(9).fillColor(WHITE60).font('Helvetica').text('  - ' + line, rX + 20, iy, { width: colW - 36 });
    iy += 14;
  });
  iy += 6;

  // ── Arbitration Risk
  doc.fontSize(11).fillColor('#60A5FA').font('Helvetica-Bold').text('Arbitration Risk', rX + 16, iy, { width: colW - 32 });
  iy += 18;
  const arItems = [
    'Rate: 8% of dispute amount — protects against',
    'incorrect OKX AI Evaluator rulings.',
  ];
  arItems.forEach(line => {
    doc.fontSize(9).fillColor(WHITE60).font('Helvetica').text('  - ' + line, rX + 20, iy, { width: colW - 36 });
    iy += 14;
  });
  iy += 6;

  // ── Slashing Protection
  doc.fontSize(11).fillColor(GREEN).font('Helvetica-Bold').text('Slashing Protection', rX + 16, iy, { width: colW - 32 });
  iy += 18;
  const spItems = [
    'Compensation for validator slashing.',
    'Protection for stakers and node operators.',
  ];
  spItems.forEach(line => {
    doc.fontSize(9).fillColor(WHITE60).font('Helvetica').text('  - ' + line, rX + 20, iy, { width: colW - 36 });
    iy += 14;
  });

  doc.roundedRect(rX + 16, topY + cH - 62, colW - 32, 44, 8).fill(GREEN + '1A').stroke(GREEN + '40');
  doc.fontSize(10).fillColor(GREEN).font('Helvetica-Bold')
    .text('Premium from 7%   |   Dynamic Risk Score   |   Auto-payout', rX + 24, topY + cH - 46, { width: colW - 48 });

  footerLine(doc, 4);
}

// ── SLIDE 5 — Tech & Integration ─────────────────────────────────────────────
function slide5(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  badge(doc, 36, 30, 'TECHNOLOGY & INTEGRATION');
  doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold').text('Built for the', 36, 62, { width: 480 });
  doc.fontSize(28).fillColor(GOLD).font('Helvetica-Bold').text('Agent Economy.', 36, 96, { width: 480 });
  goldBar(doc, 36, 133, 280, 2);

  const cards = [
    { color: '#60A5FA', title: 'X Layer Mainnet',           sub: 'Chain 196 (OKX L2)',       detail: 'Our primary deployment network.\nFast, cheap, EVM-compatible.\nLive and audited.' },
    { color: GOLD,     title: 'OKX AI Agent Marketplace',   sub: 'ASP #7202',                detail: 'Listed agent service provider.\nAgents discover & pay Zeus\nvia native OKX AI flows.' },
    { color: GREEN,    title: 'x402 Protocol',              sub: 'HTTP-native payments',      detail: 'Agents pay per call with USDC.\nNo accounts, no approvals.\nFully autonomous M2M.' },
    { color: '#C084FC', title: 'MCP Server',                sub: '7 AI tools available',     detail: 'Plug Zeus into any agent:\nget-quote, buy-policy,\nclaim-policy, escrow + more.' },
  ];

  const cW = (W - 72 - 3 * 16) / 4;
  const cY = 152;
  const cH = 220;

  cards.forEach((c, i) => {
    const cx = 36 + i * (cW + 16);
    card(doc, cx, cY, cW, cH, { fill: WHITE15, stroke: c.color + '40' });
    doc.rect(cx, cY, cW, 4).fill(c.color);

    // Title block (no emoji)
    doc.fontSize(12).fillColor(WHITE).font('Helvetica-Bold')
      .text(c.title, cx + 10, cY + 32, { width: cW - 20, align: 'center' });
    doc.fontSize(9).fillColor(c.color).font('Helvetica-Bold')
      .text(c.sub, cx + 10, cY + 58, { width: cW - 20, align: 'center' });
    goldBar(doc, cx + cW / 2 - 30, cY + 78, 60, 1);
    doc.fontSize(9).fillColor(WHITE60).font('Helvetica')
      .text(c.detail, cx + 12, cY + 90, { width: cW - 24, align: 'center', lineGap: 2 });
  });

  // Stack row
  const stackY = 392;
  card(doc, 36, stackY, W - 72, 80, { fill: WHITE08, stroke: WHITE15 });
  doc.fontSize(10).fillColor(WHITE60).font('Helvetica-Bold').text('TECH STACK', 56, stackY + 14);
  const stack = ['Solidity 0.8.27', 'OpenZeppelin v5', 'TypeScript', 'ethers v6', 'Express v5', 'Viem', 'React 19', 'Vite', 'Wagmi v3', 'Drizzle ORM', 'Hardhat 2.28'];
  stack.forEach((s, i) => {
    const sx = 56 + i * ((W - 112) / stack.length);
    doc.roundedRect(sx, stackY + 34, doc.widthOfString(s, { fontSize: 9 }) + 16, 26, 13)
      .fill(WHITE15).stroke(WHITE08);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold').text(s, sx + 8, stackY + 43);
  });

  // Bottom link
  doc.fontSize(10).fillColor(WHITE60).font('Helvetica')
    .text('OKLink explorer:  www.oklink.com/xlayer', 36, H - 56, { width: W - 72, align: 'center' });

  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold')
    .text('"Live on X Layer Mainnet. Ready for agents on OKX AI."', 36, H - 40, { width: W - 72, align: 'center' });

  footerLine(doc, 5);
}

// ── SLIDE 6 — Team & CTA ──────────────────────────────────────────────────────
function slide6(doc) {
  bg(doc);
  grid(doc);
  doc.rect(0, 0, 5, H).fill(GOLD);

  doc.save().circle(W * 0.72, H / 2, 200).fill(GOLD + '08').restore();

  badge(doc, 36, 30, 'TEAM & NEXT STEPS');
  doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold').text('Ready to Build the', 36, 62, { width: 560 });
  doc.fontSize(28).fillColor(GOLD).font('Helvetica-Bold').text('Future of Trust.', 36, 96, { width: 560 });
  goldBar(doc, 36, 133, 280, 2);

  const tY = 152;

  // Team card
  card(doc, 36, tY, 340, 170, { fill: WHITE15, stroke: WHITE08 });
  doc.fontSize(11).fillColor(WHITE60).font('Helvetica-Bold').text('FOUNDER', 56, tY + 18);
  doc.fontSize(17).fillColor(WHITE).font('Helvetica-Bold').text('Igor Ivanov', 56, tY + 36);
  doc.fontSize(10).fillColor(GOLD).font('Helvetica-Bold').text('Founder & Protocol Engineer', 56, tY + 58);
  goldBar(doc, 56, tY + 78, 60, 1);
  doc.fontSize(10).fillColor(WHITE60).font('Helvetica')
    .text('Deep expertise in Solidity, TypeScript,\nand DeFi protocol design.\nDeployed contracts on Ethereum, Base,\nand X Layer Mainnets.', 56, tY + 90, { width: 300, lineGap: 2 });

  ['Solidity', 'Smart Contracts', 'DeFi', 'TypeScript', 'Web3'].forEach((s, i) => {
    const chipX = 56 + i * 58;
    const cW2 = doc.widthOfString(s, { fontSize: 8 }) + 14;
    doc.roundedRect(chipX, tY + 152, cW2, 18, 9).fill(GOLD + '1A').stroke(GOLD + '40');
    doc.fontSize(8).fillColor(GOLD).font('Helvetica-Bold').text(s, chipX + 7, tY + 157, { lineBreak: false });
  });

  // Traction card
  card(doc, 36, tY + 186, 340, 110, { fill: WHITE15, stroke: WHITE08 });
  doc.fontSize(11).fillColor(WHITE60).font('Helvetica-Bold').text('TRACTION', 56, tY + 204);
  const tractions = [
    'Deployed on X Layer Mainnet (Chain 196)',
    'Listed on OKX AI Agent Marketplace (ASP #7202)',
    'MCP Server with 7 AI agent tools',
    'x402 Protocol integration live',
  ];
  tractions.forEach((text, i) => {
    doc.fontSize(10).fillColor(GREEN).font('Helvetica-Bold').text('[+]', 56, tY + 222 + i * 19);
    doc.fontSize(10).fillColor(WHITE60).font('Helvetica').text(text, 80, tY + 222 + i * 19, { width: 280 });
  });

  // Right: CTA
  const ctaX = 420;
  const ctaY = 152;
  const ctaW = W - ctaX - 36;

  zeusShield(doc, ctaX + ctaW / 2 - 70, ctaY, 140);
  doc.fontSize(22).fillColor(GOLD).font('Helvetica-Bold')
    .text('ZEUS', ctaX, ctaY + 148, { width: ctaW, align: 'center' });
  doc.fontSize(13).fillColor(WHITE60).font('Helvetica')
    .text('Insurance Protocol', ctaX, ctaY + 174, { width: ctaW, align: 'center' });

  goldBar(doc, ctaX + ctaW / 2 - 60, ctaY + 198, 120, 2);

  doc.fontSize(11).fillColor(WHITE).font('Helvetica')
    .text('Decentralized insurance and escrow\nfor the agentic economy.\n\nLive on X Layer Mainnet.', ctaX, ctaY + 212, { width: ctaW, align: 'center', lineGap: 3 });

  const btnW = 220;
  const btnX = ctaX + ctaW / 2 - btnW / 2;
  const btnY = ctaY + 290;
  doc.roundedRect(btnX, btnY, btnW, 42, 21).fill(GOLD);
  doc.fontSize(12).fillColor('#080c14').font('Helvetica-Bold')
    .text('Explore Zeus on OKX AI', btnX, btnY + 15, { width: btnW, align: 'center', lineBreak: false });

  doc.fontSize(9).fillColor(WHITE60).font('Helvetica')
    .text('t.me/IvanovVII   |   zeusinsurance@mail.ru   |   github.com/igor-vii/Zeus-Insurance-Escrow',
      ctaX, btnY + 62, { width: ctaW, align: 'center' });

  footerLine(doc, 6);
}

// ── Build the PDF ─────────────────────────────────────────────────────────────
const doc = new PDFDocument({
  size: [W, H],
  margin: 0,
  info: {
    Title:    'Zeus Insurance Protocol — OKX Fund Pitch Deck',
    Author:   'Igor Ivanov',
    Subject:  'Decentralized Insurance for AI Agents',
    Keywords: 'Zeus, Insurance, X Layer, OKX, AI Agents, DeFi',
  },
});

const stream = fs.createWriteStream(OUT);
doc.pipe(stream);

slide1(doc); doc.addPage();
slide2(doc); doc.addPage();
slide3(doc); doc.addPage();
slide4(doc); doc.addPage();
slide5(doc); doc.addPage();
slide6(doc);

doc.end();

stream.on('finish', () => {
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`PDF saved: ${OUT} (${size} KB)`);
});
stream.on('error', (e) => { console.error('ERROR:', e.message); process.exit(1); });
