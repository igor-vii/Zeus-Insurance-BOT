import React, { createContext, useContext, useState, useEffect } from 'react';

export type Lang = 'en' | 'ru' | 'es' | 'zh' | 'hi' | 'fa';

export const RTL_LANGS: Lang[] = ['fa'];

export const LANG_LABELS: Record<Lang, string> = {
  en: 'EN',
  ru: 'RU',
  es: 'ES',
  zh: '中文',
  hi: 'हि',
  fa: 'فا',
};

export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  zh: '中文',
  hi: 'हिन्दी',
  fa: 'فارسی',
};

type Translations = {
  nav: {
    home: string;
    about: string;
    team: string;
    docs: string;
    contacts: string;
    launch_app: string;
  };
  hero: {
    badge: string;
    title1: string;
    title2: string;
    subtitle: string;
    cta_buy: string;
    cta_docs: string;
    stat_reserve: string;
    stat_reserve_label: string;
    stat_policies: string;
    stat_policies_label: string;
    stat_payout: string;
    stat_payout_label: string;
  };
  features: {
    title: string;
    subtitle: string;
    f1_title: string;
    f1_desc: string;
    f2_title: string;
    f2_desc: string;
    f3_title: string;
    f3_desc: string;
    f4_title: string;
    f4_desc: string;
  };
  how: {
    title: string;
    subtitle: string;
    s1_title: string;
    s1_desc: string;
    s2_title: string;
    s2_desc: string;
    s3_title: string;
    s3_desc: string;
    s4_title: string;
    s4_desc: string;
  };
  cta: {
    title: string;
    subtitle: string;
    btn: string;
    docs: string;
  };
  footer: {
    slogan: string;
    product: string;
    company: string;
    connect: string;
    rights: string;
  };
  about: {
    badge: string;
    title: string;
    subtitle: string;
    problem_title: string;
    problem_desc: string;
    solution_title: string;
    solution_desc: string;
    mission_title: string;
    mission_desc: string;
    vision_title: string;
    vision_desc: string;
    values_title: string;
    v1: string;
    v2: string;
    v3: string;
    v4: string;
  };
  team: {
    badge: string;
    title: string;
    subtitle: string;
    github_btn: string;
    founder_name: string;
    founder_role: string;
    founder_desc: string;
    join_title: string;
    join_desc: string;
    join_btn: string;
  };
  docs: {
    badge: string;
    title: string;
    subtitle: string;
    guide_title: string;
    guide_badge: string;
    step1_title: string;
    step1_desc: string;
    step2_title: string;
    step2_desc: string;
    step3_title: string;
    step3_desc: string;
    step4_title: string;
    step4_desc: string;
    step5_title: string;
    step5_desc: string;
    contracts_title: string;
    contracts_desc: string;
    github_btn: string;
    api_title: string;
    api_desc: string;
  };
  contacts: {
    badge: string;
    title: string;
    subtitle: string;
    telegram_label: string;
    email_label: string;
    github_label: string;
    response_title: string;
    response_desc: string;
  };
};

const translations: Record<Lang, Translations> = {
  en: {
    nav: {
      home: 'Home',
      about: 'About',
      team: 'Team',
      docs: 'Docs',
      contacts: 'Contacts',
      launch_app: 'Launch App',
    },
    hero: {
      badge: 'Decentralized Insurance Protocol',
      title1: 'Trust in Code.',
      title2: 'Guaranteed by Zeus.',
      subtitle:
        'Zeus Insurance is a decentralized protocol for the AI-agent economy. When your agent pays for an API call and the seller fails to deliver — Zeus automatically refunds the buyer from the reserve fund.',
      cta_buy: 'Buy Policy',
      cta_docs: 'Read Docs',
      stat_reserve: '$10.14',
      stat_reserve_label: 'Total Reserve (USDC)',
      stat_policies: '∞',
      stat_policies_label: 'Policies Covered',
      stat_payout: '100%',
      stat_payout_label: 'Automated Payouts',
    },
    features: {
      title: 'Built for the Agent Economy',
      subtitle: 'Every feature is designed to make M2M commerce safe and reliable.',
      f1_title: 'Instant Payouts',
      f1_desc: 'Smart contracts automatically pay out when a seller misses the deadline. No disputes, no delays.',
      f2_title: 'On-Chain Transparency',
      f2_desc: 'Every policy, premium, and payout is recorded on X Layer Mainnet (Chain ID 196). Fully auditable by anyone.',
      f3_title: 'Micro-Premiums',
      f3_desc: 'Premiums start from 7% of the insured amount — affordable even for small API transactions.',
      f4_title: 'Agent-Native API',
      f4_desc: 'AI agents can buy and claim policies via REST API — no frontend required.',
    },
    how: {
      title: 'How It Works',
      subtitle: 'Insure any payment in under 5 minutes.',
      s1_title: 'Connect Wallet',
      s1_desc: 'Connect your MetaMask or any Web3 wallet to X Layer Mainnet.',
      s2_title: 'Approve USDC',
      s2_desc: 'Approve the insurance contract to spend USDC on your behalf.',
      s3_title: 'Buy Policy',
      s3_desc: 'Set seller address, amount, timeout, and pay the premium. Policy is active instantly.',
      s4_title: 'Auto Payout',
      s4_desc: 'If the seller fails to deliver before the timeout, claim your full refund with one click.',
    },
    cta: {
      title: 'Ready to Protect Your Payments?',
      subtitle: 'Join the decentralized insurance protocol for AI agents and developers.',
      btn: 'Launch App',
      docs: 'View Documentation',
    },
    footer: {
      slogan: 'Your agent\'s payment, guaranteed.',
      product: 'Product',
      company: 'Company',
      connect: 'Connect',
      rights: '© 2025 Zeus Insurance. All rights reserved.',
    },
    about: {
      badge: 'About the Protocol',
      title: 'Insurance for the Agent Economy',
      subtitle: 'Zeus Insurance solves the trust problem in M2M commerce.',
      problem_title: 'The Problem',
      problem_desc:
        'When AI agents transact with each other autonomously, there is no human to resolve disputes. An agent can pay for an API service, and if the seller fails to deliver, the funds are lost — with no recourse.',
      solution_title: 'The Solution',
      solution_desc:
        'Zeus Insurance is a decentralized smart-contract protocol on X Layer Mainnet. Buyers pay a small premium to insure a payment. If the seller misses the delivery deadline, the smart contract automatically pays out from the reserve fund.',
      mission_title: 'Our Mission',
      mission_desc:
        'Make M2M commerce safe and reliable, so agents can trust each other.',
      vision_title: 'Our Vision',
      vision_desc:
        'A world where AI agents transact freely, backed by trustless on-chain guarantees — not human intermediaries.',
      values_title: 'Our Values',
      v1: 'Transparency — everything on-chain',
      v2: 'Automation — no human in the loop',
      v3: 'Accessibility — affordable for any transaction size',
      v4: 'Security — auditable smart contracts',
    },
    team: {
      badge: 'The Team',
      title: 'Built by Developers, for Developers',
      subtitle: 'A small team focused on making the agent economy trustworthy.',
      github_btn: 'GitHub Profile',
      founder_name: 'Igor Ivanov',
      founder_role: 'Founder & Protocol Engineer',
      founder_desc:
        'Building decentralized infrastructure for the AI-agent economy. Created Zeus Insurance to solve the trust problem in autonomous M2M transactions.',
      join_title: 'Want to Contribute?',
      join_desc: 'Zeus Insurance is open source. We welcome contributors — protocol engineers, frontend developers, and documentation writers.',
      join_btn: 'View on GitHub',
    },
    docs: {
      badge: 'Documentation',
      title: 'Insure a Payment in 5 Minutes',
      subtitle: 'Everything you need to integrate Zeus Insurance into your agent workflow.',
      guide_title: 'Quick Start Guide',
      guide_badge: '5 min',
      step1_title: 'Get Testnet ETH',
      step1_desc: 'Visit the Coinbase X Layer Mainnet faucet and fund your wallet with OKX native token for gas.',
      step2_title: 'Get Testnet USDC',
      step2_desc: 'The testnet USDC address on X Layer Mainnet is 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
      step3_title: 'Connect & Approve',
      step3_desc: 'Open the app, connect your wallet, and approve the insurance contract to spend USDC.',
      step4_title: 'Buy a Policy',
      step4_desc: 'Enter the seller address, USDC amount, and timeout. Pay the premium and the policy is live.',
      step5_title: 'Claim if Needed',
      step5_desc: 'If the seller misses the deadline, go to My Policies and click "Claim" to get a full refund.',
      contracts_title: 'Deployed Contracts',
      contracts_desc: 'All contracts are deployed on X Layer Mainnet (Chain ID 196).',
      github_btn: 'View Source on GitHub',
      api_title: 'REST API for Agents',
      api_desc: 'AI agents can interact with the protocol without a frontend. The API server returns calldata — your agent signs and broadcasts the transaction.',
    },
    contacts: {
      badge: 'Get in Touch',
      title: 'Contact Us',
      subtitle: 'Questions, integrations, partnerships — we\'re here.',
      telegram_label: 'Telegram',
      email_label: 'Email',
      github_label: 'GitHub',
      response_title: 'Response Time',
      response_desc: 'We typically respond within 24 hours on Telegram.',
    },
  },

  ru: {
    nav: {
      home: 'Главная',
      about: 'О нас',
      team: 'Команда',
      docs: 'Документация',
      contacts: 'Контакты',
      launch_app: 'Запустить',
    },
    hero: {
      badge: 'Децентрализованный протокол страхования',
      title1: 'Доверяй коду.',
      title2: 'Гарантирует Зевс.',
      subtitle:
        'Zeus Insurance — децентрализованный протокол страхования для экономики AI-агентов. Когда агент платит за API, а продавец не выполняет работу — Зевс автоматически возвращает деньги покупателю из резервного фонда.',
      cta_buy: 'Купить полис',
      cta_docs: 'Документация',
      stat_reserve: '$10.14',
      stat_reserve_label: 'Резервный фонд (USDC)',
      stat_policies: '∞',
      stat_policies_label: 'Застрахованных платежей',
      stat_payout: '100%',
      stat_payout_label: 'Автоматические выплаты',
    },
    features: {
      title: 'Создан для экономики агентов',
      subtitle: 'Каждая функция делает M2M-коммерцию безопасной и надёжной.',
      f1_title: 'Мгновенные выплаты',
      f1_desc: 'Смарт-контракт автоматически выплачивает компенсацию при просрочке продавца. Без споров и задержек.',
      f2_title: 'On-chain прозрачность',
      f2_desc: 'Каждый полис, премия и выплата записаны в X Layer Mainnet (тестнет; в будущем — Base Mainnet). Полностью верифицируемо.',
      f3_title: 'Микропремии',
      f3_desc: 'Премии от 7% от застрахованной суммы — доступно даже для небольших API-транзакций.',
      f4_title: 'API для агентов',
      f4_desc: 'AI-агенты могут покупать и активировать полисы через REST API — без фронтенда.',
    },
    how: {
      title: 'Как это работает',
      subtitle: 'Застрахуй платёж за 5 минут.',
      s1_title: 'Подключи кошелёк',
      s1_desc: 'Подключи MetaMask или любой Web3-кошелёк к X Layer Mainnet тестнету.',
      s2_title: 'Одобри USDC',
      s2_desc: 'Разреши контракту страхования тратить USDC от твоего имени.',
      s3_title: 'Купи полис',
      s3_desc: 'Укажи адрес продавца, сумму, таймаут и оплати премию. Полис активируется мгновенно.',
      s4_title: 'Автовыплата',
      s4_desc: 'Если продавец не выполнил работу в срок — вы можете получить полный возврат средств одним кликом после истечения дедлайна.',
    },
    cta: {
      title: 'Готов защитить платежи?',
      subtitle: 'Присоединяйся к децентрализованному протоколу страхования для AI-агентов.',
      btn: 'Запустить приложение',
      docs: 'Читать документацию',
    },
    footer: {
      slogan: 'Платежи твоего агента — под защитой.',
      product: 'Продукт',
      company: 'Компания',
      connect: 'Контакты',
      rights: '© 2025 Zeus Insurance. Все права защищены.',
    },
    about: {
      badge: 'О протоколе',
      title: 'Страхование для экономики агентов',
      subtitle: 'Zeus Insurance решает проблему доверия в M2M-коммерции.',
      problem_title: 'Проблема',
      problem_desc:
        'Когда AI-агенты взаимодействуют автономно, нет человека для разрешения споров. Агент может заплатить за API-сервис, и если продавец не выполнит работу — средства пропадут без возможности возврата.',
      solution_title: 'Решение',
      solution_desc:
        'Zeus Insurance — децентрализованный смарт-контрактный протокол на X Layer Mainnet. Покупатели платят небольшую премию для страхования платежа. Если продавец пропускает дедлайн — смарт-контракт автоматически выплачивает компенсацию из резервного фонда.',
      mission_title: 'Наша миссия',
      mission_desc:
        'Сделать M2M-коммерцию безопасной и надёжной, чтобы агенты могли доверять друг другу.',
      vision_title: 'Наше видение',
      vision_desc:
        'Мир, где AI-агенты свободно проводят транзакции, опираясь на доверенные on-chain гарантии — а не человеческих посредников.',
      values_title: 'Наши ценности',
      v1: 'Прозрачность — всё в блокчейне',
      v2: 'Автоматизация — без участия человека',
      v3: 'Доступность — для транзакций любого размера',
      v4: 'Безопасность — аудируемые смарт-контракты',
    },
    team: {
      badge: 'Команда',
      title: 'Создано разработчиками для разработчиков',
      subtitle: 'Небольшая команда, сфокусированная на надёжности агентной экономики.',
      github_btn: 'GitHub профиль',
      founder_name: 'Игорь Иванов',
      founder_role: 'Основатель и протокол-инженер',
      founder_desc:
        'Строю децентрализованную инфраструктуру для экономики AI-агентов. Создал Zeus Insurance для решения проблемы доверия в автономных M2M-транзакциях.',
      join_title: 'Хочешь внести вклад?',
      join_desc: 'Zeus Insurance — open source проект. Ждём контрибьюторов: протокол-инженеров, фронтенд-разработчиков и технических писателей.',
      join_btn: 'Смотреть на GitHub',
    },
    docs: {
      badge: 'Документация',
      title: 'Застрахуй платёж за 5 минут',
      subtitle: 'Всё необходимое для интеграции Zeus Insurance в рабочий процесс агента.',
      guide_title: 'Быстрый старт',
      guide_badge: '5 мин',
      step1_title: 'Получи тестовый ETH',
      step1_desc: 'Зайди на Coinbase X Layer Mainnet faucet и пополни кошелёк тестовым ETH для газа.',
      step2_title: 'Получи тестовый USDC',
      step2_desc: 'Адрес тестового USDC на X Layer Mainnet: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
      step3_title: 'Подключись и одобри',
      step3_desc: 'Открой приложение, подключи кошелёк и разреши контракту тратить USDC.',
      step4_title: 'Купи полис',
      step4_desc: 'Введи адрес продавца, сумму USDC и таймаут. Оплати премию — полис активен.',
      step5_title: 'Активируй выплату',
      step5_desc: 'Если продавец пропустил дедлайн — зайди в "Мои полисы" и нажми "Claim" для полного возврата.',
      contracts_title: 'Задеплоенные контракты',
      contracts_desc: 'Все контракты задеплоены на X Layer Mainnet (Chain ID 196).',
      github_btn: 'Исходный код на GitHub',
      api_title: 'REST API для агентов',
      api_desc: 'AI-агенты могут взаимодействовать с протоколом без фронтенда. API-сервер возвращает calldata — агент подписывает и отправляет транзакцию.',
    },
    contacts: {
      badge: 'Связаться',
      title: 'Контакты',
      subtitle: 'Вопросы, интеграции, партнёрства — мы здесь.',
      telegram_label: 'Telegram',
      email_label: 'Email',
      github_label: 'GitHub',
      response_title: 'Время ответа',
      response_desc: 'Обычно отвечаем в течение 24 часов в Telegram.',
    },
  },

  es: {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
      team: 'Equipo',
      docs: 'Docs',
      contacts: 'Contacto',
      launch_app: 'Abrir App',
    },
    hero: {
      badge: 'Protocolo de Seguro Descentralizado',
      title1: 'Confía en el código.',
      title2: 'Garantizado por Zeus.',
      subtitle:
        'Zeus Insurance es un protocolo descentralizado para la economía de agentes de IA. Cuando tu agente paga por una llamada API y el vendedor no entrega — Zeus reembolsa automáticamente al comprador desde el fondo de reserva.',
      cta_buy: 'Comprar Póliza',
      cta_docs: 'Ver Docs',
      stat_reserve: '$10.14',
      stat_reserve_label: 'Reserva Total (USDC)',
      stat_policies: '∞',
      stat_policies_label: 'Pagos Asegurados',
      stat_payout: '100%',
      stat_payout_label: 'Pagos Automáticos',
    },
    features: {
      title: 'Construido para la Economía de Agentes',
      subtitle: 'Cada función está diseñada para hacer el comercio M2M seguro y confiable.',
      f1_title: 'Pagos Instantáneos',
      f1_desc: 'Los contratos inteligentes pagan automáticamente cuando el vendedor incumple el plazo. Sin disputas ni demoras.',
      f2_title: 'Transparencia On-Chain',
      f2_desc: 'Cada póliza, prima y pago está registrado en X Layer Mainnet. Completamente auditable.',
      f3_title: 'Micro-Primas',
      f3_desc: 'Las primas comienzan desde el 7% del monto asegurado — asequible para cualquier transacción.',
      f4_title: 'API Nativa para Agentes',
      f4_desc: 'Los agentes de IA pueden comprar y reclamar pólizas vía REST API — sin frontend.',
    },
    how: {
      title: 'Cómo Funciona',
      subtitle: 'Asegura cualquier pago en menos de 5 minutos.',
      s1_title: 'Conecta tu Wallet',
      s1_desc: 'Conecta MetaMask o cualquier wallet Web3 a la testnet X Layer Mainnet.',
      s2_title: 'Aprueba USDC',
      s2_desc: 'Autoriza al contrato de seguro a gastar USDC en tu nombre.',
      s3_title: 'Compra una Póliza',
      s3_desc: 'Ingresa la dirección del vendedor, monto, tiempo límite y paga la prima.',
      s4_title: 'Pago Automático',
      s4_desc: 'Si el vendedor no entrega antes del límite, reclama tu reembolso completo con un clic.',
    },
    cta: {
      title: '¿Listo para Proteger tus Pagos?',
      subtitle: 'Únete al protocolo de seguro descentralizado para agentes de IA.',
      btn: 'Abrir Aplicación',
      docs: 'Ver Documentación',
    },
    footer: {
      slogan: 'El pago de tu agente, garantizado.',
      product: 'Producto',
      company: 'Empresa',
      connect: 'Contacto',
      rights: '© 2025 Zeus Insurance. Todos los derechos reservados.',
    },
    about: {
      badge: 'Acerca del Protocolo',
      title: 'Seguro para la Economía de Agentes',
      subtitle: 'Zeus Insurance resuelve el problema de confianza en el comercio M2M.',
      problem_title: 'El Problema',
      problem_desc: 'Cuando los agentes de IA transaccionan de forma autónoma, no hay un humano para resolver disputas. Un agente puede pagar por un servicio API, y si el vendedor no entrega, los fondos se pierden sin recurso.',
      solution_title: 'La Solución',
      solution_desc: 'Zeus Insurance es un protocolo descentralizado de contratos inteligentes en X Layer Mainnet. Los compradores pagan una pequeña prima para asegurar un pago. Si el vendedor incumple el plazo, el contrato inteligente paga automáticamente desde el fondo de reserva.',
      mission_title: 'Nuestra Misión',
      mission_desc: 'Hacer el comercio M2M seguro y confiable, para que los agentes puedan confiar entre sí.',
      vision_title: 'Nuestra Visión',
      vision_desc: 'Un mundo donde los agentes de IA transaccionan libremente, respaldados por garantías on-chain sin confianza — no intermediarios humanos.',
      values_title: 'Nuestros Valores',
      v1: 'Transparencia — todo en la cadena',
      v2: 'Automatización — sin humanos en el proceso',
      v3: 'Accesibilidad — asequible para cualquier transacción',
      v4: 'Seguridad — contratos inteligentes auditables',
    },
    team: {
      badge: 'El Equipo',
      title: 'Construido por Desarrolladores, para Desarrolladores',
      subtitle: 'Un equipo pequeño enfocado en hacer confiable la economía de agentes.',
      github_btn: 'Perfil de GitHub',
      founder_name: 'Igor Ivanov',
      founder_role: 'Fundador e Ingeniero de Protocolo',
      founder_desc: 'Construyendo infraestructura descentralizada para la economía de agentes de IA. Creó Zeus Insurance para resolver el problema de confianza en transacciones M2M autónomas.',
      join_title: '¿Quieres Contribuir?',
      join_desc: 'Zeus Insurance es código abierto. Bienvenidos ingenieros de protocolo, desarrolladores frontend y escritores de documentación.',
      join_btn: 'Ver en GitHub',
    },
    docs: {
      badge: 'Documentación',
      title: 'Asegura un Pago en 5 Minutos',
      subtitle: 'Todo lo que necesitas para integrar Zeus Insurance en tu flujo de trabajo de agentes.',
      guide_title: 'Guía de Inicio Rápido',
      guide_badge: '5 min',
      step1_title: 'Obtén ETH de Prueba',
      step1_desc: 'Visita el faucet de Coinbase X Layer Mainnet y financia tu wallet con ETH de prueba para gas.',
      step2_title: 'Obtén USDC de Prueba',
      step2_desc: 'La dirección de USDC de prueba en X Layer Mainnet es 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
      step3_title: 'Conecta y Aprueba',
      step3_desc: 'Abre la app, conecta tu wallet y aprueba el contrato para gastar USDC.',
      step4_title: 'Compra una Póliza',
      step4_desc: 'Ingresa la dirección del vendedor, monto USDC y tiempo límite. Paga la prima — la póliza está activa.',
      step5_title: 'Reclama si es Necesario',
      step5_desc: 'Si el vendedor incumple el plazo, ve a Mis Pólizas y haz clic en "Claim" para reembolso completo.',
      contracts_title: 'Contratos Desplegados',
      contracts_desc: 'Todos los contratos están desplegados en X Layer Mainnet (Chain ID 196).',
      github_btn: 'Ver Código en GitHub',
      api_title: 'REST API para Agentes',
      api_desc: 'Los agentes de IA pueden interactuar con el protocolo sin frontend. El servidor API devuelve calldata — tu agente firma y difunde la transacción.',
    },
    contacts: {
      badge: 'Contáctanos',
      title: 'Contacto',
      subtitle: 'Preguntas, integraciones, asociaciones — estamos aquí.',
      telegram_label: 'Telegram',
      email_label: 'Correo Electrónico',
      github_label: 'GitHub',
      response_title: 'Tiempo de Respuesta',
      response_desc: 'Generalmente respondemos en 24 horas por Telegram.',
    },
  },

  zh: {
    nav: {
      home: '首页',
      about: '关于',
      team: '团队',
      docs: '文档',
      contacts: '联系',
      launch_app: '启动应用',
    },
    hero: {
      badge: '去中心化保险协议',
      title1: '信任代码。',
      title2: '由宙斯保障。',
      subtitle:
        'Zeus Insurance 是面向 AI 智能体经济的去中心化保险协议。当您的智能体为 API 调用付款而卖方未能交付时，Zeus 将自动从储备金中退款给买方。',
      cta_buy: '购买保单',
      cta_docs: '查看文档',
      stat_reserve: '$10.14',
      stat_reserve_label: '总储备金 (USDC)',
      stat_policies: '∞',
      stat_policies_label: '已承保支付',
      stat_payout: '100%',
      stat_payout_label: '自动赔付',
    },
    features: {
      title: '专为智能体经济构建',
      subtitle: '每项功能都旨在让 M2M 商业变得安全可靠。',
      f1_title: '即时赔付',
      f1_desc: '当卖方错过截止日期时，智能合约自动赔付。无需争议，无需等待。',
      f2_title: '链上透明度',
      f2_desc: '每项保单、保费和赔付均记录在 X Layer Mainnet 上，完全可审计。',
      f3_title: '微额保费',
      f3_desc: '保费从承保金额的 7% 起，即使是小额 API 交易也能负担。',
      f4_title: '原生智能体 API',
      f4_desc: 'AI 智能体可通过 REST API 购买和申请保单，无需前端界面。',
    },
    how: {
      title: '工作原理',
      subtitle: '5 分钟内为任何支付投保。',
      s1_title: '连接钱包',
      s1_desc: '将 MetaMask 或任何 Web3 钱包连接到 X Layer 主网。',
      s2_title: '授权 USDC',
      s2_desc: '授权保险合约代表您使用 USDC。',
      s3_title: '购买保单',
      s3_desc: '设置卖方地址、金额、超时时间并支付保费，保单即时生效。',
      s4_title: '自动赔付',
      s4_desc: '如果卖方在超时前未能交付，一键申请全额退款。',
    },
    cta: {
      title: '准备好保护您的支付了吗？',
      subtitle: '加入面向 AI 智能体和开发者的去中心化保险协议。',
      btn: '启动应用',
      docs: '查看文档',
    },
    footer: {
      slogan: '您的智能体支付，有保障。',
      product: '产品',
      company: '公司',
      connect: '联系',
      rights: '© 2025 Zeus Insurance. 保留所有权利。',
    },
    about: {
      badge: '关于协议',
      title: '智能体经济的保险',
      subtitle: 'Zeus Insurance 解决了 M2M 商业中的信任问题。',
      problem_title: '问题',
      problem_desc: '当 AI 智能体自主交易时，没有人工来解决争议。智能体可能为 API 服务付款，但如果卖方未能交付，资金将丢失且无法追回。',
      solution_title: '解决方案',
      solution_desc: 'Zeus Insurance 是 X Layer Mainnet 上的去中心化智能合约协议。买方支付小额保费为支付投保。如果卖方错过交付截止日期，智能合约将自动从储备金中赔付。',
      mission_title: '我们的使命',
      mission_desc: '使 M2M 商业安全可靠，让智能体之间能够相互信任。',
      vision_title: '我们的愿景',
      vision_desc: '一个 AI 智能体可以自由交易的世界，由无需信任的链上保证支撑，而非人工中介。',
      values_title: '我们的价值观',
      v1: '透明度 — 一切上链',
      v2: '自动化 — 无需人工介入',
      v3: '可及性 — 适合任何规模的交易',
      v4: '安全性 — 可审计的智能合约',
    },
    team: {
      badge: '团队',
      title: '由开发者为开发者构建',
      subtitle: '专注于让智能体经济可信赖的小团队。',
      github_btn: 'GitHub 主页',
      founder_name: 'Igor Ivanov',
      founder_role: '创始人及协议工程师',
      founder_desc: '为 AI 智能体经济构建去中心化基础设施。创建了 Zeus Insurance 来解决自主 M2M 交易中的信任问题。',
      join_title: '想要贡献？',
      join_desc: 'Zeus Insurance 是开源项目。欢迎协议工程师、前端开发者和文档撰写者加入。',
      join_btn: '在 GitHub 上查看',
    },
    docs: {
      badge: '文档',
      title: '5 分钟内为支付投保',
      subtitle: '将 Zeus Insurance 集成到智能体工作流所需的一切。',
      guide_title: '快速入门指南',
      guide_badge: '5 分钟',
      step1_title: '获取测试网 ETH',
      step1_desc: '访问 Coinbase X Layer Mainnet 水龙头，为您的钱包获取测试网 ETH 用于 gas。',
      step2_title: '获取测试网 USDC',
      step2_desc: 'X Layer 主网 USDC 地址：0x036CbD53842c5426634e7929541eC2318f3dCF7e。',
      step3_title: '连接并授权',
      step3_desc: '打开应用，连接钱包，并授权保险合约使用 USDC。',
      step4_title: '购买保单',
      step4_desc: '输入卖方地址、USDC 金额和超时时间。支付保费，保单即刻生效。',
      step5_title: '申请赔付',
      step5_desc: '如果卖方错过截止日期，前往"我的保单"并点击"Claim"获取全额退款。',
      contracts_title: '已部署合约',
      contracts_desc: '所有合约均部署在 X Layer Mainnet（Chain ID 196）上。',
      github_btn: '在 GitHub 上查看源码',
      api_title: '面向智能体的 REST API',
      api_desc: 'AI 智能体无需前端即可与协议交互。API 服务器返回 calldata — 您的智能体签名并广播交易。',
    },
    contacts: {
      badge: '联系我们',
      title: '联系方式',
      subtitle: '问题、集成、合作 — 我们在这里。',
      telegram_label: 'Telegram',
      email_label: '邮箱',
      github_label: 'GitHub',
      response_title: '响应时间',
      response_desc: '我们通常在 24 小时内通过 Telegram 回复。',
    },
  },

  hi: {
    nav: {
      home: 'होम',
      about: 'हमारे बारे में',
      team: 'टीम',
      docs: 'दस्तावेज़',
      contacts: 'संपर्क',
      launch_app: 'ऐप खोलें',
    },
    hero: {
      badge: 'विकेंद्रीकृत बीमा प्रोटोकॉल',
      title1: 'कोड पर भरोसा करें।',
      title2: 'ज़्यूस की गारंटी।',
      subtitle:
        'Zeus Insurance AI एजेंट इकॉनमी के लिए एक विकेंद्रीकृत बीमा प्रोटोकॉल है। जब आपका एजेंट API कॉल के लिए भुगतान करता है और विक्रेता डिलीवर नहीं करता — Zeus रिज़र्व फंड से खरीदार को स्वचालित रूप से वापस भुगतान करता है।',
      cta_buy: 'पॉलिसी खरीदें',
      cta_docs: 'दस्तावेज़ देखें',
      stat_reserve: '$10.14',
      stat_reserve_label: 'कुल रिज़र्व (USDC)',
      stat_policies: '∞',
      stat_policies_label: 'बीमित भुगतान',
      stat_payout: '100%',
      stat_payout_label: 'स्वचालित भुगतान',
    },
    features: {
      title: 'एजेंट इकॉनमी के लिए बनाया गया',
      subtitle: 'हर सुविधा M2M कॉमर्स को सुरक्षित और विश्वसनीय बनाने के लिए डिज़ाइन की गई है।',
      f1_title: 'तत्काल भुगतान',
      f1_desc: 'जब विक्रेता समयसीमा चूक जाता है तो स्मार्ट कॉन्ट्रैक्ट स्वचालित रूप से भुगतान करता है।',
      f2_title: 'ऑन-चेन पारदर्शिता',
      f2_desc: 'हर पॉलिसी, प्रीमियम और भुगतान X Layer Mainnet पर दर्ज है। पूरी तरह से ऑडिट योग्य।',
      f3_title: 'माइक्रो-प्रीमियम',
      f3_desc: 'प्रीमियम बीमित राशि के 7% से शुरू होता है — छोटे API लेनदेन के लिए भी किफायती।',
      f4_title: 'एजेंट-नेटिव API',
      f4_desc: 'AI एजेंट REST API के माध्यम से पॉलिसी खरीद और क्लेम कर सकते हैं।',
    },
    how: {
      title: 'यह कैसे काम करता है',
      subtitle: '5 मिनट में किसी भी भुगतान का बीमा करें।',
      s1_title: 'वॉलेट कनेक्ट करें',
      s1_desc: 'MetaMask या किसी भी Web3 वॉलेट को X Layer Mainnet टेस्टनेट से कनेक्ट करें।',
      s2_title: 'USDC अप्रूव करें',
      s2_desc: 'बीमा कॉन्ट्रैक्ट को आपकी ओर से USDC खर्च करने की अनुमति दें।',
      s3_title: 'पॉलिसी खरीदें',
      s3_desc: 'विक्रेता का पता, राशि, टाइमआउट सेट करें और प्रीमियम का भुगतान करें।',
      s4_title: 'स्वतः भुगतान',
      s4_desc: 'अगर विक्रेता समयसीमा से पहले डिलीवर नहीं करता, एक क्लिक में पूरा रिफंड पाएं।',
    },
    cta: {
      title: 'अपने भुगतानों की सुरक्षा के लिए तैयार हैं?',
      subtitle: 'AI एजेंटों और डेवलपर्स के लिए विकेंद्रीकृत बीमा प्रोटोकॉल में शामिल हों।',
      btn: 'ऐप लॉन्च करें',
      docs: 'दस्तावेज़ देखें',
    },
    footer: {
      slogan: 'आपके एजेंट का भुगतान, गारंटीड।',
      product: 'उत्पाद',
      company: 'कंपनी',
      connect: 'संपर्क',
      rights: '© 2025 Zeus Insurance. सर्वाधिकार सुरक्षित।',
    },
    about: {
      badge: 'प्रोटोकॉल के बारे में',
      title: 'एजेंट इकॉनमी के लिए बीमा',
      subtitle: 'Zeus Insurance M2M कॉमर्स में विश्वास की समस्या को हल करता है।',
      problem_title: 'समस्या',
      problem_desc: 'जब AI एजेंट स्वायत्त रूप से लेनदेन करते हैं, तो विवादों को सुलझाने के लिए कोई मानव नहीं होता। एक एजेंट API सेवा के लिए भुगतान कर सकता है, और अगर विक्रेता डिलीवर नहीं करता, तो फंड खो जाते हैं।',
      solution_title: 'समाधान',
      solution_desc: 'Zeus Insurance, X Layer Mainnet पर एक विकेंद्रीकृत स्मार्ट-कॉन्ट्रैक्ट प्रोटोकॉल है। खरीदार भुगतान सुरक्षित करने के लिए छोटा प्रीमियम देते हैं। अगर विक्रेता डेडलाइन चूक जाता है, स्मार्ट कॉन्ट्रैक्ट रिज़र्व फंड से स्वचालित रूप से भुगतान करता है।',
      mission_title: 'हमारा मिशन',
      mission_desc: 'M2M कॉमर्स को सुरक्षित और विश्वसनीय बनाना, ताकि एजेंट एक-दूसरे पर भरोसा कर सकें।',
      vision_title: 'हमारी दृष्टि',
      vision_desc: 'एक ऐसी दुनिया जहां AI एजेंट स्वतंत्र रूप से लेनदेन करें, ट्रस्टलेस ऑन-चेन गारंटी द्वारा समर्थित।',
      values_title: 'हमारे मूल्य',
      v1: 'पारदर्शिता — सब कुछ ऑन-चेन',
      v2: 'स्वचालन — प्रक्रिया में कोई मानव नहीं',
      v3: 'सुलभता — किसी भी लेनदेन आकार के लिए',
      v4: 'सुरक्षा — ऑडिट योग्य स्मार्ट कॉन्ट्रैक्ट',
    },
    team: {
      badge: 'टीम',
      title: 'डेवलपर्स द्वारा, डेवलपर्स के लिए बनाया गया',
      subtitle: 'एजेंट इकॉनमी को विश्वसनीय बनाने पर केंद्रित छोटी टीम।',
      github_btn: 'GitHub प्रोफाइल',
      founder_name: 'Igor Ivanov',
      founder_role: 'संस्थापक और प्रोटोकॉल इंजीनियर',
      founder_desc: 'AI एजेंट इकॉनमी के लिए विकेंद्रीकृत इन्फ्रास्ट्रक्चर बना रहे हैं। स्वायत्त M2M लेनदेन में विश्वास की समस्या हल करने के लिए Zeus Insurance बनाया।',
      join_title: 'योगदान करना चाहते हैं?',
      join_desc: 'Zeus Insurance ओपन सोर्स है। प्रोटोकॉल इंजीनियर, फ्रंटएंड डेवलपर और डॉक्यूमेंटेशन लेखकों का स्वागत है।',
      join_btn: 'GitHub पर देखें',
    },
    docs: {
      badge: 'दस्तावेज़ीकरण',
      title: '5 मिनट में भुगतान का बीमा करें',
      subtitle: 'Zeus Insurance को अपने एजेंट वर्कफ्लो में एकीकृत करने के लिए सब कुछ।',
      guide_title: 'त्वरित प्रारंभ मार्गदर्शिका',
      guide_badge: '5 मिनट',
      step1_title: 'टेस्टनेट ETH प्राप्त करें',
      step1_desc: 'Coinbase X Layer Mainnet फॉसेट पर जाएं और गैस के लिए टेस्टनेट ETH से अपना वॉलेट फंड करें।',
      step2_title: 'टेस्टनेट USDC प्राप्त करें',
      step2_desc: 'X Layer Mainnet पर टेस्टनेट USDC पता: 0x036CbD53842c5426634e7929541eC2318f3dCF7e।',
      step3_title: 'कनेक्ट और अप्रूव करें',
      step3_desc: 'ऐप खोलें, अपना वॉलेट कनेक्ट करें, और USDC खर्च करने के लिए कॉन्ट्रैक्ट को अप्रूव करें।',
      step4_title: 'पॉलिसी खरीदें',
      step4_desc: 'विक्रेता का पता, USDC राशि और टाइमआउट दर्ज करें। प्रीमियम भुगतान करें — पॉलिसी सक्रिय है।',
      step5_title: 'क्लेम करें अगर ज़रूरी हो',
      step5_desc: 'अगर विक्रेता डेडलाइन चूक जाता है, My Policies में जाएं और पूर्ण रिफंड के लिए "Claim" पर क्लिक करें।',
      contracts_title: 'तैनात कॉन्ट्रैक्ट',
      contracts_desc: 'सभी कॉन्ट्रैक्ट X Layer Mainnet (Chain ID 196) पर तैनात हैं।',
      github_btn: 'GitHub पर सोर्स देखें',
      api_title: 'एजेंटों के लिए REST API',
      api_desc: 'AI एजेंट फ्रंटएंड के बिना प्रोटोकॉल के साथ इंटरैक्ट कर सकते हैं। API सर्वर calldata लौटाता है — आपका एजेंट हस्ताक्षर करता और प्रसारित करता है।',
    },
    contacts: {
      badge: 'संपर्क करें',
      title: 'संपर्क',
      subtitle: 'प्रश्न, एकीकरण, साझेदारी — हम यहां हैं।',
      telegram_label: 'Telegram',
      email_label: 'ईमेल',
      github_label: 'GitHub',
      response_title: 'प्रतिक्रिया समय',
      response_desc: 'हम आमतौर पर Telegram पर 24 घंटे के भीतर जवाब देते हैं।',
    },
  },

  fa: {
    nav: {
      home: 'خانه',
      about: 'درباره ما',
      team: 'تیم',
      docs: 'مستندات',
      contacts: 'تماس',
      launch_app: 'راه‌اندازی',
    },
    hero: {
      badge: 'پروتکل بیمه غیرمتمرکز',
      title1: 'به کد اعتماد کن.',
      title2: 'تضمین‌شده توسط زئوس.',
      subtitle:
        'Zeus Insurance یک پروتکل بیمه غیرمتمرکز برای اقتصاد عامل‌های هوش مصنوعی است. وقتی عامل شما برای فراخوانی API پرداخت می‌کند و فروشنده تحویل نمی‌دهد — Zeus به‌طور خودکار از صندوق ذخیره به خریدار بازپرداخت می‌کند.',
      cta_buy: 'خرید بیمه‌نامه',
      cta_docs: 'مستندات',
      stat_reserve: '$10.14',
      stat_reserve_label: 'ذخیره کل (USDC)',
      stat_policies: '∞',
      stat_policies_label: 'پرداخت‌های بیمه‌شده',
      stat_payout: '100%',
      stat_payout_label: 'پرداخت‌های خودکار',
    },
    features: {
      title: 'ساخته‌شده برای اقتصاد عامل',
      subtitle: 'هر ویژگی برای ایمن و قابل‌اعتماد کردن تجارت M2M طراحی شده است.',
      f1_title: 'پرداخت فوری',
      f1_desc: 'قراردادهای هوشمند به‌طور خودکار پرداخت می‌کنند وقتی فروشنده مهلت را از دست می‌دهد.',
      f2_title: 'شفافیت زنجیره‌ای',
      f2_desc: 'هر بیمه‌نامه، حق بیمه و پرداخت در X Layer Mainnet ثبت می‌شود. کاملاً قابل حسابرسی.',
      f3_title: 'حق بیمه‌های خرد',
      f3_desc: 'حق بیمه از ۷٪ مبلغ بیمه‌شده شروع می‌شود — مقرون‌به‌صرفه حتی برای تراکنش‌های کوچک.',
      f4_title: 'API بومی عامل',
      f4_desc: 'عامل‌های هوش مصنوعی می‌توانند از طریق REST API بیمه‌نامه بخرند و مطالبه کنند.',
    },
    how: {
      title: 'چگونه کار می‌کند',
      subtitle: 'هر پرداختی را در کمتر از ۵ دقیقه بیمه کنید.',
      s1_title: 'اتصال کیف‌پول',
      s1_desc: 'MetaMask یا هر کیف‌پول Web3 را به شبکه تست X Layer Mainnet متصل کنید.',
      s2_title: 'تأیید USDC',
      s2_desc: 'به قرارداد بیمه اجازه دهید USDC را از طرف شما خرج کند.',
      s3_title: 'خرید بیمه‌نامه',
      s3_desc: 'آدرس فروشنده، مبلغ، زمان انقضا را تنظیم کنید و حق بیمه را پرداخت کنید.',
      s4_title: 'پرداخت خودکار',
      s4_desc: 'اگر فروشنده قبل از انقضا تحویل ندهد، با یک کلیک بازپرداخت کامل دریافت کنید.',
    },
    cta: {
      title: 'آماده محافظت از پرداخت‌های خود هستید؟',
      subtitle: 'به پروتکل بیمه غیرمتمرکز برای عامل‌های هوش مصنوعی بپیوندید.',
      btn: 'راه‌اندازی برنامه',
      docs: 'مشاهده مستندات',
    },
    footer: {
      slogan: 'پرداخت عامل شما، تضمین‌شده.',
      product: 'محصول',
      company: 'شرکت',
      connect: 'ارتباط',
      rights: '© ۲۰۲۵ Zeus Insurance. تمام حقوق محفوظ است.',
    },
    about: {
      badge: 'درباره پروتکل',
      title: 'بیمه برای اقتصاد عامل',
      subtitle: 'Zeus Insurance مشکل اعتماد در تجارت M2M را حل می‌کند.',
      problem_title: 'مشکل',
      problem_desc: 'وقتی عامل‌های هوش مصنوعی به‌طور مستقل معامله می‌کنند، هیچ انسانی برای حل اختلافات وجود ندارد. یک عامل می‌تواند برای خدمات API پرداخت کند، و اگر فروشنده تحویل ندهد، وجوه از دست می‌رود.',
      solution_title: 'راه‌حل',
      solution_desc: 'Zeus Insurance یک پروتکل قرارداد هوشمند غیرمتمرکز در X Layer Mainnet است. خریداران حق بیمه کمی برای بیمه پرداخت می‌پردازند. اگر فروشنده مهلت تحویل را از دست بدهد، قرارداد هوشمند به‌طور خودکار از صندوق ذخیره پرداخت می‌کند.',
      mission_title: 'مأموریت ما',
      mission_desc: 'تجارت M2M را ایمن و قابل‌اعتماد کنید تا عامل‌ها بتوانند به یکدیگر اعتماد کنند.',
      vision_title: 'چشم‌انداز ما',
      vision_desc: 'دنیایی که عامل‌های هوش مصنوعی آزادانه معامله می‌کنند، با تضمین‌های زنجیره‌ای بدون نیاز به اعتماد — نه واسطه‌های انسانی.',
      values_title: 'ارزش‌های ما',
      v1: 'شفافیت — همه چیز روی زنجیره',
      v2: 'اتوماسیون — بدون دخالت انسان',
      v3: 'دسترسی‌پذیری — مقرون‌به‌صرفه برای هر اندازه تراکنش',
      v4: 'امنیت — قراردادهای هوشمند قابل حسابرسی',
    },
    team: {
      badge: 'تیم',
      title: 'ساخته‌شده توسط توسعه‌دهندگان، برای توسعه‌دهندگان',
      subtitle: 'تیم کوچکی که بر قابل‌اعتماد کردن اقتصاد عامل تمرکز دارد.',
      github_btn: 'پروفایل GitHub',
      founder_name: 'Igor Ivanov',
      founder_role: 'بنیان‌گذار و مهندس پروتکل',
      founder_desc: 'در حال ساخت زیرساخت غیرمتمرکز برای اقتصاد عامل هوش مصنوعی. Zeus Insurance را برای حل مشکل اعتماد در تراکنش‌های M2M مستقل ایجاد کرد.',
      join_title: 'می‌خواهید مشارکت کنید؟',
      join_desc: 'Zeus Insurance متن‌باز است. از مهندسان پروتکل، توسعه‌دهندگان فرانت‌اند و نویسندگان مستندات استقبال می‌کنیم.',
      join_btn: 'مشاهده در GitHub',
    },
    docs: {
      badge: 'مستندات',
      title: 'بیمه یک پرداخت در ۵ دقیقه',
      subtitle: 'هر آنچه برای ادغام Zeus Insurance در گردش کار عامل خود نیاز دارید.',
      guide_title: 'راهنمای شروع سریع',
      guide_badge: '۵ دقیقه',
      step1_title: 'ETH تستنت دریافت کنید',
      step1_desc: 'به فاست Coinbase X Layer Mainnet مراجعه کنید و کیف‌پول خود را با ETH تستنت برای گاز شارژ کنید.',
      step2_title: 'USDC تستنت دریافت کنید',
      step2_desc: 'آدرس USDC تستنت در X Layer Mainnet: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
      step3_title: 'اتصال و تأیید',
      step3_desc: 'برنامه را باز کنید، کیف‌پول خود را متصل کنید و قرارداد را برای خرج کردن USDC تأیید کنید.',
      step4_title: 'بیمه‌نامه بخرید',
      step4_desc: 'آدرس فروشنده، مبلغ USDC و زمان انقضا را وارد کنید. حق بیمه را پرداخت کنید — بیمه‌نامه فعال است.',
      step5_title: 'در صورت نیاز مطالبه کنید',
      step5_desc: 'اگر فروشنده مهلت را از دست داد، به «بیمه‌نامه‌های من» بروید و برای بازپرداخت کامل روی «Claim» کلیک کنید.',
      contracts_title: 'قراردادهای مستقرشده',
      contracts_desc: 'تمام قراردادها در X Layer Mainnet (Chain ID 196) مستقر هستند.',
      github_btn: 'مشاهده کد در GitHub',
      api_title: 'REST API برای عامل‌ها',
      api_desc: 'عامل‌های هوش مصنوعی می‌توانند بدون فرانت‌اند با پروتکل تعامل داشته باشند. سرور API calldata برمی‌گرداند — عامل شما امضا می‌کند و تراکنش را پخش می‌کند.',
    },
    contacts: {
      badge: 'تماس با ما',
      title: 'تماس',
      subtitle: 'سؤالات، ادغام‌ها، مشارکت‌ها — اینجاییم.',
      telegram_label: 'تلگرام',
      email_label: 'ایمیل',
      github_label: 'GitHub',
      response_title: 'زمان پاسخ',
      response_desc: 'ما معمولاً در عرض ۲۴ ساعت در تلگرام پاسخ می‌دهیم.',
    },
  },
};

type I18nContextType = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Translations;
  isRTL: boolean;
};

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('zeus_lang');
    return (saved as Lang) || 'en';
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem('zeus_lang', l);
  };

  const isRTL = RTL_LANGS.includes(lang);

  useEffect(() => {
    document.documentElement.setAttribute('dir', isRTL ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', lang);
  }, [lang, isRTL]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t: translations[lang], isRTL }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
