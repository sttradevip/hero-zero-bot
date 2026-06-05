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

const MIN_DELTA = Number(process.env.MIN_DELTA || 0.20);
const MAX_DELTA = Number(process.env.MAX_DELTA || 0.55);
const MIN_GAMMA = Number(process.env.MIN_GAMMA || 0.01);
const MAX_IV = Number(process.env.MAX_IV || 1.80);

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
const lockedSymbols = new Set();

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

function calcScore({
  spreadPct,
  volume,
  openInterest,
  volumeOiRatio,
  premium,
  moveFromOpenAbs,
  deltaAbs,
  gamma,
  iv
}) {
  let score = 0;

  if (spreadPct !== null && spreadPct <= 5) score += 18;
  else if (spreadPct !== null && spreadPct <= 8) score += 14;
  else if (spreadPct !== null && spreadPct <= MAX_SPREAD_PCT) score += 8;

  if (volume >= 5000) score += 18;
  else if (volume >= 2500) score += 14;
  else if (volume >= MIN_VOLUME) score += 8;

  if (openInterest >= 5000) score += 12;
  else if (openInterest >= 2500) score += 9;
  else if (openInterest >= MIN_OPEN_INTEREST) score += 6;

  if (volumeOiRatio >= 5) score += 20;
  else if (volumeOiRatio >= 3) score += 16;
  else if (volumeOiRatio >= 2) score += 12;
  else if (volumeOiRatio >= MIN_VOLUME_OI_RATIO) score += 8;

  if (premium >= 0.25 && premium <= 0.90) score += 10;
  else if (premium >= MIN_PREMIUM && premium <= MAX_PREMIUM) score += 6;

  if (moveFromOpenAbs <= 1.0) score += 8;
  else if (moveFromOpenAbs <= MAX_MOVE_FROM_OPEN) score += 4;

  if (deltaAbs >= 0.25 && deltaAbs <= 0.45) score += 8;
  else if (deltaAbs >= MIN_DELTA && deltaAbs <= MAX_DELTA) score += 5;

  if (gamma >= MIN_GAMMA) score += 4;

  if (iv > 0 && iv <= MAX_IV) score += 2;

  return score;
}

async function getStockQuote(symbol) {

 if (symbol === 'SPX') {
  return {
    price: 6000,
    open: 6000,
    previousClose: 6000,
    changePct: 0,
    moveFromOpen: 0
  };
} 

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

  if (!(price > 0)) {
    throw new Error(`لا يوجد سعر من Finnhub للرمز ${symbol}`);
  }

  const changePct = previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const moveFromOpen = open > 0 ? ((price - open) / open) * 100 : null;

  return {
    price,
    open,
    previousClose,
    changePct,
    moveFromOpen
  };
}

function allowedDirection(quote) {
  if (quote.price > quote.open) return 'CALL';
  if (quote.price < quote.open) return 'PUT';
  return 'NONE';
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

  const delta = Number(greeks.delta || 0);
  const gamma = Number(greeks.gamma || 0);
  const iv = Number(row.implied_volatility || 0);

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
    delta,
    gamma,
    iv
  };
}

async function getContractByTicker(symbol, ticker) {
  const chain = await getOptionChain(symbol);
  const contracts = chain.map(normalizeContract);
  return contracts.find(c => c.ticker === ticker) || null;
}

function pickBestContracts(symbol, stockPrice, chain, quote) {
  const direction = allowedDirection(quote);
  const moveFromOpenAbs = Math.abs(Number(quote.moveFromOpen || 0));

  if (direction === 'NONE') return [];

  const normalized = chain
    .map(normalizeContract)
    .filter(c => {
      const deltaAbs = Math.abs(Number(c.delta || 0));

      return (
        c.ticker &&
        c.side === direction &&
        Number.isFinite(c.strike) &&
        c.premium !== null &&
        c.premium >= MIN_PREMIUM &&
        c.premium <= MAX_PREMIUM &&
        c.volume >= MIN_VOLUME &&
        c.openInterest >= MIN_OPEN_INTEREST &&
        c.volumeOiRatio >= MIN_VOLUME_OI_RATIO &&
        c.spreadPct !== null &&
        c.spreadPct <= MAX_SPREAD_PCT &&
        deltaAbs >= MIN_DELTA &&
        deltaAbs <= MAX_DELTA &&
        c.gamma >= MIN_GAMMA &&
        (c.iv === 0 || c.iv <= MAX_IV)
      );
    });

  let contracts = [];

  if (direction === 'CALL') {
    contracts = normalized
      .filter(c => c.strike > stockPrice)
      .sort((a, b) => a.strike - b.strike);
  }

  if (direction === 'PUT') {
    contracts = normalized
      .filter(c => c.strike < stockPrice)
      .sort((a, b) => b.strike - a.strike);
  }

  const candidates = contracts.slice(0, 3).map(c => ({
    ...c,
    score: calcScore({
      spreadPct: c.spreadPct,
      volume: c.volume,
      openInterest: c.openInterest,
      volumeOiRatio: c.volumeOiRatio,
      premium: c.premium,
      moveFromOpenAbs,
      deltaAbs: Math.abs(c.delta),
      gamma: c.gamma,
      iv: c.iv
    })
  }));

  if (!candidates.length) return [];

  return [candidates.sort((a, b) => b.score - a.score)[0]];
}

console.log(
  'SPX CANDIDATES:',
  candidates.map(x => ({
    strike: x.strike,
    side: x.side,
    score: x.score,
    premium: x.premium,
    delta: x.delta,
    gamma: x.gamma,
    iv: x.iv,
    volume: x.volume,
    oi: x.openInterest,
    spread: x.spreadPct
  }))
);

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
🧬 Delta: ${n(c.delta, 3)}
⚡ Gamma: ${n(c.gamma, 4)}
🌡️ IV: ${n(c.iv, 2)}

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
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    isClosed: false,
    createdAt: new Date().toISOString()
  });
}

function targetStatus(currentPremium, targetPremium) {
  return currentPremium >= targetPremium ? '✅ تحقق' : '⏳ لم يتحقق';
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

function buildTp3Message(trade, current) {
  const profitPremium = current.premium - trade.entryPremium;

  return `
🏆 تحقق الهدف الثالث — هيرو زيرو

📊 السهم: ${trade.symbol}
🎯 العقد:
${trade.contractName}
${trade.ticker}

💵 دخول العقد: ${n(trade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
✅ الربح الحالي: +${n(profitPremium)}

🔥 الصفقة حققت كامل أهدافها.
ارفع وقفك إذا بتستمر، وانتبه لعقدك.
`.trim();
}

async function scanSymbol(symbol) {
  try {
    if (lockedSymbols.has(symbol)) {
      console.log(`${symbol}: مقفل بسبب وجود صفقة نشطة`);
      return;
    }

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

    const candidates = pickBestContracts(symbol, quote.price, chain, quote);

    if (!candidates.length) {
      console.log(`${symbol}: لا يوجد عقد هيرو مناسب مع فلتر الاتجاه`);
      return;
    }

    for (const c of candidates) {
      const key = `${todayET()}_${symbol}_${c.ticker}`;

      if (sentKeys.has(key)) continue;

      console.log(`${symbol} ${c.side} ${c.ticker} score ${c.score}`);

      if (c.score >= MIN_HERO_SCORE) {
        await bot.sendMessage(ADMIN_CHAT_ID, buildAlert(symbol, quote, c));

        sentKeys.add(key);
        lockedSymbols.add(symbol);
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

      if (!trade.tp1Hit && current.premium >= trade.targets.tp1) {
        trade.tp1Hit = true;
      }

      if (!trade.tp2Hit && current.premium >= trade.targets.tp2) {
        trade.tp2Hit = true;
      }

      if (!trade.tp3Hit && current.premium >= trade.targets.tp3) {
        trade.tp3Hit = true;
        trade.isClosed = true;

        await bot.sendMessage(ADMIN_CHAT_ID, buildTp3Message(trade, current));

        lockedSymbols.delete(trade.symbol);
        activeTrades.delete(key);
        continue;
      }

      if (current.premium <= trade.stopPremium) {
        trade.isClosed = true;

        await bot.sendMessage(ADMIN_CHAT_ID, buildStopMessage(trade, current));

        lockedSymbols.delete(trade.symbol);
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

✅ قفل الرمز:
لن يعطي صفقة ثانية على نفس السهم حتى تنتهي الصفقة الحالية.

✅ فلتر الاتجاه:
CALL فقط إذا السعر فوق الافتتاح
PUT فقط إذا السعر تحت الافتتاح

✅ فلتر Greeks:
Delta / Gamma / IV مفعلة.`
  );

  await scanAll();
  setInterval(scanAll, SCAN_INTERVAL_MS);
}

start().catch(err => {
  console.error('BOT FATAL ERROR:', err.response?.data || err.message);
  process.exit(1);
});
