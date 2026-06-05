require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// ===============================
// ENV
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID missing in .env');
if (!MASSIVE_API_KEY) throw new Error('MASSIVE_API_KEY missing in .env');

// ===============================
// SPX ONLY SETTINGS
// ===============================
const SYMBOL = 'SPX';
const MASSIVE_BASE_URL = 'https://api.massive.com';

const SCAN_INTERVAL_MS = 60 * 1000;
const MIN_SCORE = 85;
const MAX_SPREAD_PCT = 18;
const MIN_VOLUME = 20;
const MIN_OI = 50;
const MAX_CONTRACTS_TO_CHECK = 80;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let activeTrade = null;
let lastSignalKey = null;

// ===============================
// HELPERS
// ===============================
function n(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'N/A';
  return x.toFixed(d);
}

function pct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'N/A';
  return `${x.toFixed(2)}%`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nextFridayDate() {
  const d = new Date();
  const day = d.getDay();
  const add = (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

function isMarketTimeKSA() {
  const now = new Date();
  const ksa = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));

  const day = ksa.getDay();
  const hour = ksa.getHours();
  const min = ksa.getMinutes();
  const total = hour * 60 + min;

  if (day === 0 || day === 6) return false;

  return total >= 16 * 60 + 30 && total <= 23 * 60;
}

async function massiveGet(path, params = {}) {
  const url = `${MASSIVE_BASE_URL}${path}`;

  const res = await axios.get(url, {
    params: {
      ...params,
      apiKey: MASSIVE_API_KEY
    },
    timeout: 15000
  });

  return res.data;
}

// ===============================
// SPX PRICE ONLY
// ===============================
async function getSpxPrice() {
  try {
    const data = await massiveGet('/v2/aggs/ticker/I:SPX/prev');
    const r = data?.results?.[0];
    if (!r) return null;

    return {
      price: Number(r.c),
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c)
    };
  } catch (e) {
    console.log('SPX PRICE ERROR:', e.message);
    return null;
  }
}

// ===============================
// SPX OPTIONS ONLY
// ===============================
async function getSpxContracts(expiration) {
  try {
    const data = await massiveGet('/v3/reference/options/contracts', {
      underlying_ticker: 'SPX',
      expiration_date: expiration,
      limit: 1000
    });

    return data?.results || [];
  } catch (e) {
    console.log('CONTRACTS ERROR:', e.message);
    return [];
  }
}

async function getOptionSnapshot(optionTicker) {
  try {
    const data = await massiveGet(`/v3/snapshot/options/SPX/${optionTicker}`);
    return data?.results || null;
  } catch (e) {
    console.log('OPTION SNAPSHOT ERROR:', optionTicker, e.message);
    return null;
  }
}

async function getCurrentOptionPrice(optionTicker) {
  const snap = await getOptionSnapshot(optionTicker);
  if (!snap) return null;

  const o = analyzeOption(snap);
  return o.price;
}

// ===============================
// CONTRACT ANALYSIS
// ===============================
function pickNearContracts(contracts, spxPrice) {
  return contracts
    .filter(c => c.ticker && c.strike_price && c.contract_type)
    .map(c => ({
      ticker: c.ticker,
      strike: Number(c.strike_price),
      type: String(c.contract_type).toUpperCase(),
      expiration: c.expiration_date
    }))
    .filter(c => c.type === 'CALL' || c.type === 'PUT')
    .sort((a, b) => Math.abs(a.strike - spxPrice) - Math.abs(b.strike - spxPrice))
    .slice(0, MAX_CONTRACTS_TO_CHECK);
}

function analyzeOption(snapshot) {
  const day = snapshot?.day || {};
  const details = snapshot?.details || {};
  const last = snapshot?.last_trade || {};
  const quote = snapshot?.last_quote || {};
  const greeks = snapshot?.greeks || {};

  const oi = Number(snapshot?.open_interest || 0);

  const bid = Number(quote.bid || 0);
  const ask = Number(quote.ask || 0);

  const fallbackPrice = Number(last.price || day.close || 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : fallbackPrice;

  const spreadPct =
    bid > 0 && ask > 0 && mid > 0
      ? ((ask - bid) / mid) * 100
      : 999;

  const volume = Number(day.volume || 0);
  const delta = Number(greeks.delta || 0);
  const gamma = Number(greeks.gamma || 0);

  return {
    ticker: details.ticker,
    strike: Number(details.strike_price),
    type: String(details.contract_type || '').toUpperCase(),
    expiration: details.expiration_date,
    bid,
    ask,
    price: mid,
    volume,
    oi,
    spreadPct,
    delta,
    gamma
  };
}

function scoreContract(o, side, spxPrice) {
  let score = 0;

  if (o.price > 0) score += 10;
  if (o.spreadPct <= MAX_SPREAD_PCT) score += 25;
  if (o.volume >= MIN_VOLUME) score += 20;
  if (o.oi >= MIN_OI) score += 15;

  const distance = Math.abs(o.strike - spxPrice);

  if (distance <= 10) score += 15;
  else if (distance <= 25) score += 10;
  else if (distance <= 40) score += 5;

  if (side === 'CALL' && o.delta > 0.25 && o.delta < 0.70) score += 10;
  if (side === 'PUT' && o.delta < -0.25 && o.delta > -0.70) score += 10;

  if (Math.abs(o.gamma) > 0) score += 5;

  return Math.min(score, 100);
}

function detectDirection(spx) {
  const change = spx.close - spx.open;
  const changePct = (change / spx.open) * 100;

  if (changePct >= 0.15) return 'CALL';
  if (changePct <= -0.15) return 'PUT';

  return 'NEUTRAL';
}

// ===============================
// FIND BEST SPX TRADE
// ===============================
async function findBestTrade() {
  const spx = await getSpxPrice();
  if (!spx?.price) return null;

  const side = detectDirection(spx);
  if (side === 'NEUTRAL') return null;

  const expiration = nextFridayDate();

  const contracts = await getSpxContracts(expiration);
  if (!contracts.length) return null;

  const near = pickNearContracts(contracts, spx.price).filter(c => c.type === side);

  const analyzed = [];

  for (const c of near) {
    const snap = await getOptionSnapshot(c.ticker);
    if (!snap) continue;

    const opt = analyzeOption(snap);
    const score = scoreContract(opt, side, spx.price);

    if (
      opt.price > 0 &&
      opt.spreadPct <= MAX_SPREAD_PCT &&
      opt.volume >= MIN_VOLUME &&
      opt.oi >= MIN_OI
    ) {
      analyzed.push({
        ...opt,
        score
      });
    }
  }

  analyzed.sort((a, b) => b.score - a.score);

  const best = analyzed[0];
  if (!best || best.score < MIN_SCORE) return null;

  const entry = best.price;

  return {
    side,
    symbol: SYMBOL,
    spxPrice: spx.price,
    optionTicker: best.ticker,
    strike: best.strike,
    expiration: best.expiration,

    entry,
    tp1: entry * 1.20,
    tp2: entry * 1.40,
    tp3: entry * 1.70,
    sl: entry * 0.70,

    score: best.score,
    volume: best.volume,
    oi: best.oi,
    spreadPct: best.spreadPct,
    delta: best.delta,
    gamma: best.gamma,

    hitTp1: false,
    hitTp2: false,
    hitTp3: false,

    openedAt: new Date().toISOString()
  };
}

// ===============================
// MESSAGES
// ===============================
function tradeMessage(t) {
  return `
🚨 SPX ONLY TRADE

📊 الأصل: SPX فقط
🧭 الاتجاه: ${t.side === 'CALL' ? '🟢 CALL' : '🔴 PUT'}
💵 سعر SPX: ${n(t.spxPrice)}

━━━━━━━━━━━━━━
📄 العقد
━━━━━━━━━━━━━━
🎯 العقد: ${t.optionTicker}
📌 السترايك: ${t.strike}
📅 الانتهاء: ${t.expiration}

━━━━━━━━━━━━━━
📍 الخطة
━━━━━━━━━━━━━━
✅ الدخول: ${n(t.entry)}
🎯 TP1: ${n(t.tp1)}
🎯 TP2: ${n(t.tp2)}
🎯 TP3: ${n(t.tp3)}
🛑 SL: ${n(t.sl)}

━━━━━━━━━━━━━━
🧠 جودة العقد
━━━━━━━━━━━━━━
🔥 التقييم: ${t.score}/100
📊 Volume: ${t.volume}
📦 OI: ${t.oi}
📏 Spread: ${pct(t.spreadPct)}
Δ Delta: ${n(t.delta, 3)}
Γ Gamma: ${n(t.gamma, 4)}

⚠️ SPX فقط — لا SPY ولا أي بديل.
`;
}

// ===============================
// MONITOR ACTIVE TRADE
// ===============================
async function monitorActiveTrade() {
  if (!activeTrade) return;

  const price = await getCurrentOptionPrice(activeTrade.optionTicker);
  if (!price) return;

  if (!activeTrade.hitTp1 && price >= activeTrade.tp1) {
    activeTrade.hitTp1 = true;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `✅ SPX وصل TP1

العقد: ${activeTrade.optionTicker}
السعر الحالي: ${n(price)}

ارفع وقفك وخلك صاحي لعقدك.`
    );
  }

  if (!activeTrade.hitTp2 && price >= activeTrade.tp2) {
    activeTrade.hitTp2 = true;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `✅ SPX وصل TP2

العقد: ${activeTrade.optionTicker}
السعر الحالي: ${n(price)}

ممتاز. خذ ربحك أو ارفع الوقف.`
    );
  }

  if (!activeTrade.hitTp3 && price >= activeTrade.tp3) {
    activeTrade.hitTp3 = true;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔥 SPX وصل TP3

العقد: ${activeTrade.optionTicker}
السعر الحالي: ${n(price)}

الهدف الثالث تحقق. إذا بتستمر ارفع وقفك وانتبه لعقدك.`
    );

    activeTrade = null;
    lastSignalKey = null;
    return;
  }

  if (price <= activeTrade.sl) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🛑 SPX ضرب وقف الخسارة

العقد: ${activeTrade.optionTicker}
السعر الحالي: ${n(price)}`
    );

    activeTrade = null;
    lastSignalKey = null;
  }
}

// ===============================
// SCANNER
// ===============================
async function scan() {
  try {
    if (!isMarketTimeKSA()) return;

    if (activeTrade) {
      await monitorActiveTrade();
      return;
    }

    const trade = await findBestTrade();
    if (!trade) return;

    const key = `${trade.side}-${trade.optionTicker}-${today()}`;
    if (key === lastSignalKey) return;

    activeTrade = trade;
    lastSignalKey = key;

    await bot.sendMessage(ADMIN_CHAT_ID, tradeMessage(trade));
  } catch (e) {
    console.log('SCAN ERROR:', e.message);
  }
}

// ===============================
// BOT COMMANDS
// ===============================
bot.onText(/\/start/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;

  bot.sendMessage(
    msg.chat.id,
    '✅ بوت SPX شغال. يراقب SPX فقط.'
  );
});

bot.onText(/\/status/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;

  if (!activeTrade) {
    bot.sendMessage(msg.chat.id, 'لا توجد صفقة SPX مفتوحة حالياً.');
    return;
  }

  bot.sendMessage(msg.chat.id, tradeMessage(activeTrade));
});

bot.onText(/\/scan/, async msg => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;

  const trade = await findBestTrade();

  if (!trade) {
    bot.sendMessage(msg.chat.id, 'ما فيه صفقة SPX مناسبة الآن.');
    return;
  }

  activeTrade = trade;
  lastSignalKey = `${trade.side}-${trade.optionTicker}-${today()}`;

  bot.sendMessage(msg.chat.id, tradeMessage(trade));
});

bot.onText(/\/close/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;

  activeTrade = null;
  lastSignalKey = null;

  bot.sendMessage(msg.chat.id, 'تم إغلاق صفقة SPX يدوياً.');
});

bot.on('message', msg => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
});

// ===============================
// START
// ===============================
console.log('SPX ONLY BOT STARTED');

setInterval(scan, SCAN_INTERVAL_MS);
scan();
