require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

const HERO_SYMBOLS = String(process.env.HERO_SYMBOLS || 'SPY,QQQ,TSLA,META,AAPL')
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const MIN_HERO_SCORE = Number(process.env.MIN_HERO_SCORE || 92);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT || 12);
const MAX_MOVE_FROM_OPEN = Number(process.env.MAX_MOVE_FROM_OPEN || 2.5);

const MIN_VOLUME = Number(process.env.MIN_VOLUME || 500);
const MIN_OPEN_INTEREST = Number(process.env.MIN_OPEN_INTEREST || 500);
const MIN_VOLUME_OI_RATIO = Number(process.env.MIN_VOLUME_OI_RATIO || 1.2);

const MIN_PREMIUM = Number(process.env.MIN_PREMIUM || 0.15);
const MAX_PREMIUM = Number(process.env.MAX_PREMIUM || 1.20);

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60 * 1000);
const PROFIT_STEP_PREMIUM = Number(process.env.PROFIT_STEP_PREMIUM || 0.10);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 35);

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID');
if (!FINNHUB_API_KEY) throw new Error('Missing FINNHUB_API_KEY');
if (!MASSIVE_API_KEY) throw new Error('Missing MASSIVE_API_KEY');

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const sentKeys = new Set();
const activeTrades = new Map();

function todayET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  return `${y}-${m}-${d}`;
}

function n(v, digits = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'غير متوفر';
  return x.toFixed(digits);
}

function pct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'غير متوفر';
  return `${x.toFixed(2)}%`;
}

function midPrice(bid, ask, fallback) {
  const b = Number(bid);
  const a = Number(ask);
  const f = Number(fallback);

  if (b > 0 && a > 0) return (b + a) / 2;
  if (a > 0) return a;
  if (b > 0) return b;
  if (f > 0) return f;

  return null;
}

function calcSpreadPct(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);

  if (!(b > 0) || !(a > 0)) return null;

  const mid = (a + b) / 2;
  if (!(mid > 0)) return null;

  return ((a - b) / mid) * 100;
}

function calcScore({ spreadPct, volume, openInterest, volumeOiRatio, premium, moveFromOpenAbs }) {
  let score = 0;

  if (spreadPct !== null && spreadPct <= 5) score += 20;
  else if (spreadPct !== null && spreadPct <= 8) score += 16;
  else if (spreadPct !== null && spreadPct <= MAX_SPREAD_PCT) score += 10;

  if (volume >= 5000) score += 20;
  else if (volume >= 2500) score += 16;
  else if (volume >= MIN_VOLUME) score += 10;

  if (openInterest >= 5000) score += 15;
  else if (openInterest >= 2500) score += 12;
  else if (openInterest >= MIN_OPEN_INTEREST) score += 8;

  if (volumeOiRatio >= 5) score += 25;
  else if (volumeOiRatio >= 3) score += 20;
  else if (volumeOiRatio >= 2) score += 15;
  else if (volumeOiRatio >= MIN_VOLUME_OI_RATIO) score += 10;

  if (premium >= 0.25 && premium <= 0.90) score += 10;
  else if (premium >= MIN_PREMIUM && premium <= MAX_PREMIUM) score += 6;

  if (moveFromOpenAbs <= 1.0) score += 10;
  else if (moveFromOpenAbs <= MAX_MOVE_FROM_OPEN) score += 5;

  return score;
}

async function getStockQuote(symbol) {
  const { data } = await axios.get('https://finnhub.io/api/v1/quote', {
    params: {
      symbol,
      token: FINNHUB_API_KEY
    },
    timeout: 15000
  });

  const price = Number(data.c);
  const open = Number(data.o);
  const previousClose = Number(data.pc);

  if (!(price > 0)) throw new Error(`لا يوجد سعر من Finnhub للرمز ${symbol}`);

  const changePct = previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const moveFromOpen = open > 0 ? ((price - open) / open) * 100 : null;

  return { price, open, previousClose, changePct, moveFromOpen };
}

async function getOptionChain(symbol) {
  const expiration = todayET();
  const url = `https://api.massive.com/v3/snapshot/options/${symbol}`;

  const { data } = await axios.get(url, {
    params: {
      expiration_date: expiration,
      limit: 250,
      apiKey: MASSIVE_API_KEY
    },
    timeout: 20000
  });

  return Array.isArray(data.results) ? data.results : [];
}

function normalizeContract(row) {
  const details = row.details || {};
  const quote = row.last_quote || {};
  const trade = row.last_trade || {};
  const greeks = row.greeks || {};

  const strike = Number(details.strike_price);
  const side = String(details.contract_type || '').toUpperCase();
  const ticker = details.ticker || '';

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const last = Number(trade.price);

  const volume = Number(row.day?.volume || 0);
  const openInterest = Number(row.open_interest || 0);

  const premium = midPrice(bid, ask, last);
  const spreadPct = calcSpreadPct(bid, ask);
  const volumeOiRatio = openInterest > 0 ? volume / openInterest : 0;

  return {
    ticker,
    strike,
    side,
    bid,
    ask,
    last,
    premium,
    spreadPct,
    volume,
    openInterest,
    volumeOiRatio,
    delta: greeks.delta,
    gamma: greeks.gamma
  };
}

async function getContractByTicker(symbol, ticker) {
  const chain = await getOptionChain(symbol);
  const contracts = chain.map(normalizeContract);
  return contracts.find(c => c.ticker === ticker) || null;
}

function pickBestContracts(symbol, stockPrice, chain, moveFromOpenAbs) {
  const normalized = chain
    .map(normalizeContract)
    .filter(c =>
      c.ticker &&
      Number.isFinite(c.strike) &&
      c.premium !== null &&
      c.premium >= MIN_PREMIUM &&
      c.premium <= MAX_PREMIUM &&
      c.volume >= MIN_VOLUME &&
      c.openInterest >= MIN_OPEN_INTEREST &&
      c.volumeOiRatio >= MIN_VOLUME_OI_RATIO &&
      c.spreadPct !== null &&
      c.spreadPct <= MAX_SPREAD_PCT
    );

  const bestCall = normalized
    .filter(c => c.side === 'CALL' && c.strike > stockPrice)
    .sort((a, b) => a.strike - b.strike)[0];

  const bestPut = normalized
    .filter(c => c.side === 'PUT' && c.strike < stockPrice)
    .sort((a, b) => b.strike - a.strike)[0];

  const candidates = [];
  if (bestCall) candidates.push(bestCall);
  if (bestPut) candidates.push(bestPut);

  const scored = candidates.map(c => ({
    ...c,
    score: calcScore({
      spreadPct: c.spreadPct,
      volume: c.volume,
      openInterest: c.openInterest,
      volumeOiRatio: c.volumeOiRatio,
      premium: c.premium,
      moveFromOpenAbs
    })
  }));

  if (!scored.length) return [];

  return [scored.sort((a, b) => b.score - a.score)[0]];
}

function shortContractName(symbol, c) {
  return `${symbol} ${c.strike}${c.side === 'CALL' ? 'C' : 'P'}`;
}

function stockStopPrice(quote, c) {
  const price = Number(quote.price);
  if (!(price > 0)) return null;

  if (c.side === 'CALL') return price * 0.995;
  return price * 1.005;
}

function stockTargets(quote, c) {
  const price = Number(quote.price);
  if (!(price > 0)) return { tp1: null, tp2: null, tp3: null };

  const step = price * 0.0025;

  if (c.side === 'CALL') {
    return {
      tp1: price + step,
      tp2: price + step * 2,
      tp3: price + step * 3
    };
  }

  return {
    tp1: price - step,
    tp2: price - step * 2,
    tp3: price - step * 3
  };
}

function buildAlert(symbol, quote, c) {
  const sideEmoji = c.side === 'CALL' ? '🟢' : '🔴';
  const sideArabic = c.side === 'CALL' ? 'كول' : 'بوت';

  const stopContract = c.premium * (1 - STOP_LOSS_PCT / 100);
  const stopStock = stockStopPrice(quote, c);
  const t = stockTargets(quote, c);

  return `
🚀 صفقة هيرو زيرو

📊 السهم: ${symbol}
${sideEmoji} النوع: ${sideArabic}
📅 الانتهاء: ${todayET()}

🎯 العقد:
${shortContractName(symbol, c)}
${c.ticker}

💰 سعر السهم الحالي: ${n(quote.price)}
📍 مستوى الدخول: ${n(quote.price)}

💵 دخول العقد: ${n(c.premium)}
🛑 وقف العقد: ${n(stopContract)}
🛑 وقف السهم: ${n(stopStock)}
📌 نوع الوقف: وقف تلقائي محسوب

🎯 أهداف السهم:
TP1: ${n(t.tp1)}
TP2: ${n(t.tp2)}
TP3: ${n(t.tp3)}

📦 OI: ${Math.round(c.openInterest).toLocaleString()}
📊 Volume: ${Math.round(c.volume).toLocaleString()}

🔥 درجة الهيرو: ${c.score}/100
📏 السبريد: ${pct(c.spreadPct)}
⚡ Vol/OI: ${n(c.volumeOiRatio, 2)}x

🔔 سيتم إرسال تحديث كلما ارتفع العقد +${n(PROFIT_STEP_PREMIUM)}

⚠️ ليست توصية شراء أو بيع
`.trim();
}

function addActiveTrade(symbol, quote, c) {
  const key = `${todayET()}_${symbol}_${c.ticker}`;

  activeTrades.set(key, {
    key,
    symbol,
    ticker: c.ticker,
    side: c.side,
    strike: c.strike,
    contractName: shortContractName(symbol, c),
    entryPremium: c.premium,
    lastPremium: c.premium,
    highestPremium: c.premium,
    stopPremium: c.premium * (1 - STOP_LOSS_PCT / 100),
    nextPremiumAlert: c.premium + PROFIT_STEP_PREMIUM,
    targets: {
      tp1: c.premium * 1.5,
      tp2: c.premium * 2.0,
      tp3: c.premium * 3.0
    },
    isClosed: false,
    createdAt: new Date().toISOString()
  });
}

function targetStatus(currentPremium, targetPremium) {
  if (currentPremium >= targetPremium) return '✅ تحقق';
  return '⏳ لم يتحقق';
}

function buildUpdateMessage(trade, current) {
  const profitPremium = current.premium - trade.entryPremium;

  return `
📈 تحديث العقد — هيرو زيرو

📊 السهم: ${trade.symbol}
🎯 العقد:
${trade.contractName}
${trade.ticker}

💵 دخول العقد: ${n(trade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
✅ الربح الحالي: +${n(profitPremium)}

🎯 حالة الأهداف:
TP1: ${targetStatus(current.premium, trade.targets.tp1)}
TP2: ${targetStatus(current.premium, trade.targets.tp2)}
TP3: ${targetStatus(current.premium, trade.targets.tp3)}

🛑 وقف العقد: ${n(trade.stopPremium)}
📦 OI: ${Math.round(current.openInterest).toLocaleString()}
📊 Volume: ${Math.round(current.volume).toLocaleString()}
`.trim();
}

function buildStopMessage(trade, current) {
  const result = current.premium - trade.entryPremium;

  return `
🛑 ضرب وقف الخسارة — هيرو زيرو

📊 السهم: ${trade.symbol}
🎯 العقد:
${trade.contractName}
${trade.ticker}

💵 دخول العقد: ${n(trade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
📉 النتيجة: ${n(result)}

⚠️ تم إغلاق متابعة الصفقة.
`.trim();
}

async function scanSymbol(symbol) {
  try {
    const quote = await getStockQuote(symbol);
    const moveAbs = Math.abs(Number(quote.moveFromOpen || 0));

    if (moveAbs > MAX_MOVE_FROM_OPEN) {
      console.log(`${symbol}: تم التجاهل بسبب الحركة من الافتتاح ${moveAbs.toFixed(2)}%`);
      return;
    }

    const chain = await getOptionChain(symbol);

    if (!chain.length) {
      console.log(`${symbol}: لا توجد عقود متاحة اليوم`);
      return;
    }

    const candidates = pickBestContracts(symbol, quote.price, chain, moveAbs);

    if (!candidates.length) {
      console.log(`${symbol}: لا يوجد عقد هيرو مناسب`);
      return;
    }

    for (const c of candidates) {
      const key = `${todayET()}_${symbol}_${c.ticker}`;

      if (sentKeys.has(key)) continue;

      console.log(`${symbol} ${c.side} ${c.ticker} score ${c.score}`);

      if (c.score >= MIN_HERO_SCORE) {
        await bot.sendMessage(ADMIN_CHAT_ID, buildAlert(symbol, quote, c));

        sentKeys.add(key);
        addActiveTrade(symbol, quote, c);
      }
    }
  } catch (err) {
    console.error(`${symbol} ERROR:`, err.response?.data || err.message);
  }
}

async function monitorActiveTrades() {
  if (!activeTrades.size) return;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.isClosed) continue;

    try {
      const current = await getContractByTicker(trade.symbol, trade.ticker);

      if (!current || current.premium === null) {
        console.log(`${trade.symbol}: لا يمكن تحديث العقد ${trade.ticker}`);
        continue;
      }

      trade.lastPremium = current.premium;
      trade.highestPremium = Math.max(trade.highestPremium, current.premium);

      while (current.premium >= trade.nextPremiumAlert) {
        await bot.sendMessage(ADMIN_CHAT_ID, buildUpdateMessage(trade, current));
        trade.nextPremiumAlert += PROFIT_STEP_PREMIUM;
      }

      if (current.premium <= trade.stopPremium) {
        trade.isClosed = true;
        await bot.sendMessage(ADMIN_CHAT_ID, buildStopMessage(trade, current));
        activeTrades.delete(key);
      }
    } catch (err) {
      console.error(`MONITOR ERROR ${trade.symbol}:`, err.response?.data || err.message);
    }
  }
}

async function scanAll() {
  console.log(`بدء الفحص: ${HERO_SYMBOLS.join(', ')}`);

  for (const symbol of HERO_SYMBOLS) {
    await scanSymbol(symbol);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await monitorActiveTrades();

  console.log(`الفحص القادم بعد ${Math.round(SCAN_INTERVAL_MS / 1000)} ثانية`);
}

async function start() {
  console.log('HERO ZERO BOT STARTED');

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🚀 تم تشغيل بوت الهيرو زيرو

📊 الرموز:
${HERO_SYMBOLS.join(', ')}

🔥 أقل درجة للإرسال:
${MIN_HERO_SCORE}

📏 أعلى سبريد:
${MAX_SPREAD_PCT}%

📍 أعلى حركة من الافتتاح:
${MAX_MOVE_FROM_OPEN}%

🔔 تحديث العقد:
كل +${n(PROFIT_STEP_PREMIUM)}

✅ الاختيار:
أفضل عقد واحد فقط لكل سهم، كول أو بوت حسب الشروط والمعطيات.`
  );

  await scanAll();
  setInterval(scanAll, SCAN_INTERVAL_MS);
}

start().catch(err => {
  console.error('BOT FATAL ERROR:', err.response?.data || err.message);
  process.exit(1);
});
