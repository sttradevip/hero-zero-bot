require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

const SYMBOL = process.env.SPX_SYMBOL || 'SPX';

const MIN_SCORE = Number(process.env.MIN_SCORE || 75);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);

const MIN_PREMIUM = Number(process.env.MIN_PREMIUM || 1);
const MAX_PREMIUM = Number(process.env.MAX_PREMIUM || 8);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT || 25);

const MIN_VOLUME = Number(process.env.MIN_VOLUME || 50);
const MIN_OPEN_INTEREST = Number(process.env.MIN_OPEN_INTEREST || 50);
const MIN_VOLUME_OI_RATIO = Number(process.env.MIN_VOLUME_OI_RATIO || 0.20);

const MIN_DELTA = Number(process.env.MIN_DELTA || 0.10);
const MAX_DELTA = Number(process.env.MAX_DELTA || 0.60);
const MIN_GAMMA = Number(process.env.MIN_GAMMA || 0.0001);
const MAX_IV = Number(process.env.MAX_IV || 5);

const PROFIT_STEP_PREMIUM = Number(process.env.PROFIT_STEP_PREMIUM || 1);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 35);

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID');
if (!MASSIVE_API_KEY) throw new Error('Missing MASSIVE_API_KEY');

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

let activeTrade = null;
const sentContracts = new Set();

function todayET() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

function n(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'غير متوفر';
  return x.toFixed(d);
}

function pct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'غير متوفر';
  return `${x.toFixed(2)}%`;
}

function midPrice(bid, ask, last) {
  const b = Number(bid);
  const a = Number(ask);
  const l = Number(last);

  if (b > 0 && a > 0) return (b + a) / 2;
  if (a > 0) return a;
  if (b > 0) return b;
  if (l > 0) return l;
  return null;
}

function spreadPct(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);

  if (!(b > 0) || !(a > 0)) return null;

  const mid = (a + b) / 2;
  if (!(mid > 0)) return null;

  return ((a - b) / mid) * 100;
}

async function getSPXChain() {
  const expiration = todayET();

  const url = `https://api.massive.com/v3/snapshot/options/${SYMBOL}`;

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

function normalize(row) {
  const details = row.details || {};
  const quote = row.last_quote || {};
  const trade = row.last_trade || {};
  const greeks = row.greeks || {};
  const day = row.day || {};
  const underlying = row.underlying_asset || {};

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const last = Number(trade.price);

  const premium = midPrice(bid, ask, last);

  const volume = Number(day.volume || 0);
  const oi = Number(row.open_interest || 0);
  const volOi = oi > 0 ? volume / oi : 0;

  return {
    ticker: details.ticker || '',
    strike: Number(details.strike_price),
    side: String(details.contract_type || '').toUpperCase(),
    expiration: details.expiration_date || todayET(),

    bid,
    ask,
    last,
    premium,
    spreadPct: spreadPct(bid, ask),

    volume,
    openInterest: oi,
    volumeOiRatio: volOi,

    delta: Number(greeks.delta || 0),
    gamma: Number(greeks.gamma || 0),
    theta: Number(greeks.theta || 0),
    vega: Number(greeks.vega || 0),
    iv: Number(row.implied_volatility || 0),

    underlyingPrice: Number(underlying.price || 0)
  };
}

function getUnderlyingPrice(contracts) {
  for (const c of contracts) {
    if (c.underlyingPrice > 0) {
      return c.underlyingPrice;
    }
  }

  const strikes = contracts
    .map(c => Number(c.strike))
    .filter(x => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);

  if (!strikes.length) {
    return null;
  }

  return strikes[Math.floor(strikes.length / 2)];
}

function isValidContract(c) {
  const deltaAbs = Math.abs(c.delta);

  return (
    c.ticker &&
    Number.isFinite(c.strike) &&
    c.premium !== null &&
    c.premium >= MIN_PREMIUM &&
    c.premium <= MAX_PREMIUM &&
    c.spreadPct !== null &&
    c.spreadPct <= MAX_SPREAD_PCT &&
    c.volume >= MIN_VOLUME &&
    c.openInterest >= MIN_OPEN_INTEREST &&
    c.volumeOiRatio >= MIN_VOLUME_OI_RATIO &&
    deltaAbs >= MIN_DELTA &&
    deltaAbs <= MAX_DELTA &&
    c.gamma >= MIN_GAMMA &&
    (c.iv === 0 || c.iv <= MAX_IV)
  );
}

function contractScore(c, underlyingPrice) {
  let score = 0;

  const deltaAbs = Math.abs(c.delta);
  const distance = Math.abs(c.strike - underlyingPrice);

  if (c.spreadPct <= 5) score += 18;
  else if (c.spreadPct <= 10) score += 14;
  else if (c.spreadPct <= MAX_SPREAD_PCT) score += 8;

  if (c.volume >= 5000) score += 18;
  else if (c.volume >= 1000) score += 14;
  else if (c.volume >= MIN_VOLUME) score += 8;

  if (c.openInterest >= 5000) score += 12;
  else if (c.openInterest >= 1000) score += 9;
  else if (c.openInterest >= MIN_OPEN_INTEREST) score += 6;

  if (c.volumeOiRatio >= 5) score += 20;
  else if (c.volumeOiRatio >= 3) score += 16;
  else if (c.volumeOiRatio >= 1) score += 12;
  else if (c.volumeOiRatio >= MIN_VOLUME_OI_RATIO) score += 8;

  if (deltaAbs >= 0.20 && deltaAbs <= 0.40) score += 10;
  else if (deltaAbs >= MIN_DELTA && deltaAbs <= MAX_DELTA) score += 6;

  if (c.gamma >= 0.01) score += 10;
  else if (c.gamma >= 0.001) score += 7;
  else if (c.gamma >= MIN_GAMMA) score += 4;

  if (c.premium >= 2 && c.premium <= 6) score += 8;
  else if (c.premium >= MIN_PREMIUM && c.premium <= MAX_PREMIUM) score += 5;

  if (distance <= 10) score += 4;
  else if (distance <= 25) score += 2;

  return Math.min(score, 100);
}

function sidePressure(validContracts, side) {
  const rows = validContracts.filter(c => c.side === side);

  let volume = 0;
  let dollarFlow = 0;
  let gammaPower = 0;

  for (const c of rows) {
    volume += c.volume;
    dollarFlow += c.volume * c.premium * 100;
    gammaPower += c.gamma * c.volume;
  }

  return { volume, dollarFlow, gammaPower };
}

function chooseDirection(validContracts) {
  const call = sidePressure(validContracts, 'CALL');
  const put = sidePressure(validContracts, 'PUT');

  const callPower = call.dollarFlow + call.gammaPower * 100000;
  const putPower = put.dollarFlow + put.gammaPower * 100000;

  if (callPower > putPower * 1.15) return 'CALL';
  if (putPower > callPower * 1.15) return 'PUT';

  return 'NONE';
}

function pickBestSPXContract(chain) {
  const normalized = chain.map(normalize);
  const underlyingPrice = getUnderlyingPrice(normalized);

  if (!underlyingPrice) {
    return { error: 'لم أستطع قراءة سعر SPX من Massive.' };
  }

  const valid = normalized.filter(isValidContract);

  if (!valid.length) {
    return {
      error: 'لا يوجد عقد SPX مناسب بعد الفلاتر.',
      underlyingPrice,
      totalContracts: normalized.length,
      validContracts: 0
    };
  }

  const direction = chooseDirection(valid);

  if (direction === 'NONE') {
    return {
      error: 'لا يوجد تفوق واضح بين الكول والبوت.',
      underlyingPrice,
      totalContracts: normalized.length,
      validContracts: valid.length
    };
  }

  const sideContracts = valid
    .filter(c => {
      if (direction === 'CALL') return c.side === 'CALL' && c.strike >= underlyingPrice;
      if (direction === 'PUT') return c.side === 'PUT' && c.strike <= underlyingPrice;
      return false;
    })
    .map(c => ({
      ...c,
      score: contractScore(c, underlyingPrice)
    }))
    .sort((a, b) => b.score - a.score);

  const best = sideContracts[0];

  if (!best) {
    return {
      error: 'يوجد اتجاه لكن لا يوجد عقد قريب مناسب.',
      underlyingPrice,
      totalContracts: normalized.length,
      validContracts: valid.length
    };
  }

  return {
    contract: best,
    underlyingPrice,
    totalContracts: normalized.length,
    validContracts: valid.length,
    direction
  };
}

function contractName(c) {
  return `SPX ${c.strike}${c.side === 'CALL' ? 'C' : 'P'}`;
}

function stockTargets(price, side) {
  const step = price * 0.0025;

  if (side === 'CALL') {
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

function buildEntryMessage(c, underlyingPrice) {
  const sideArabic = c.side === 'CALL' ? 'كول' : 'بوت';
  const sideEmoji = c.side === 'CALL' ? '🟢' : '🔴';

  const stopContract = c.premium * (1 - STOP_LOSS_PCT / 100);
  const targets = stockTargets(underlyingPrice, c.side);

  return `
🚀 صفقة SPX خاصة

📊 الأصل: SPX
${sideEmoji} النوع: ${sideArabic}
📅 الانتهاء: ${todayET()}

🎯 العقد:
${contractName(c)}
${c.ticker}

💰 سعر SPX الحالي: ${n(underlyingPrice)}
📍 مستوى الدخول: ${n(underlyingPrice)}

💵 دخول العقد: ${n(c.premium)}
🛑 وقف العقد: ${n(stopContract)}
📌 نوع الوقف: وقف تلقائي محسوب

🎯 أهداف SPX:
TP1: ${n(targets.tp1)}
TP2: ${n(targets.tp2)}
TP3: ${n(targets.tp3)}

📦 OI: ${Math.round(c.openInterest).toLocaleString()}
📊 Volume: ${Math.round(c.volume).toLocaleString()}

🔥 درجة الصفقة: ${c.score}/100
📏 السبريد: ${pct(c.spreadPct)}
⚡ Vol/OI: ${n(c.volumeOiRatio, 2)}x
🧬 Delta: ${n(c.delta, 3)}
⚡ Gamma: ${n(c.gamma, 5)}
🌡️ IV: ${n(c.iv, 2)}

🔔 سيتم إرسال تحديث كلما ارتفع العقد +${n(PROFIT_STEP_PREMIUM)}

⚠️ ليست توصية شراء أو بيع
`.trim();
}

function buildUpdateMessage(current) {
  const profit = current.premium - activeTrade.entryPremium;

  return `
📈 تحديث عقد SPX

🎯 العقد:
${activeTrade.name}
${activeTrade.ticker}

💵 دخول العقد: ${n(activeTrade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
✅ الربح الحالي: +${n(profit)}

🎯 حالة الأهداف:
TP1: ${current.premium >= activeTrade.tp1 ? '✅ تحقق' : '⏳ لم يتحقق'}
TP2: ${current.premium >= activeTrade.tp2 ? '✅ تحقق' : '⏳ لم يتحقق'}
TP3: ${current.premium >= activeTrade.tp3 ? '✅ تحقق' : '⏳ لم يتحقق'}

🛑 وقف العقد: ${n(activeTrade.stopPremium)}
📦 OI: ${Math.round(current.openInterest).toLocaleString()}
📊 Volume: ${Math.round(current.volume).toLocaleString()}
`.trim();
}

function buildStopMessage(current) {
  const result = current.premium - activeTrade.entryPremium;

  return `
🛑 ضرب وقف SPX

🎯 العقد:
${activeTrade.name}
${activeTrade.ticker}

💵 الدخول: ${n(activeTrade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
📉 النتيجة: ${n(result)}

تم إغلاق متابعة الصفقة.
`.trim();
}

function buildTp3Message(current) {
  const profit = current.premium - activeTrade.entryPremium;

  return `
🏆 تحقق الهدف الثالث — SPX

🎯 العقد:
${activeTrade.name}
${activeTrade.ticker}

💵 الدخول: ${n(activeTrade.entryPremium)}
💵 السعر الحالي: ${n(current.premium)}
✅ الربح الحالي: +${n(profit)}

🔥 الصفقة حققت كامل أهدافها.
`.trim();
}

function openTrade(c) {
  activeTrade = {
    ticker: c.ticker,
    side: c.side,
    strike: c.strike,
    name: contractName(c),
    entryPremium: c.premium,
    stopPremium: c.premium * (1 - STOP_LOSS_PCT / 100),
    nextAlert: c.premium + PROFIT_STEP_PREMIUM,
    tp1: c.premium * 1.5,
    tp2: c.premium * 2,
    tp3: c.premium * 3,
    openedAt: new Date().toISOString()
  };
}

async function getCurrentContract(ticker) {
  const chain = await getSPXChain();
  const contracts = chain.map(normalize);
  return contracts.find(c => c.ticker === ticker) || null;
}

async function monitorTrade() {
  if (!activeTrade) return;

  const current = await getCurrentContract(activeTrade.ticker);

  if (!current || current.premium === null) {
    console.log('لا يمكن تحديث العقد الحالي');
    return;
  }

  while (current.premium >= activeTrade.nextAlert) {
    await bot.sendMessage(ADMIN_CHAT_ID, buildUpdateMessage(current));
    activeTrade.nextAlert += PROFIT_STEP_PREMIUM;
  }

  if (current.premium >= activeTrade.tp3) {
    await bot.sendMessage(ADMIN_CHAT_ID, buildTp3Message(current));
    activeTrade = null;
    return;
  }

  if (current.premium <= activeTrade.stopPremium) {
    await bot.sendMessage(ADMIN_CHAT_ID, buildStopMessage(current));
    activeTrade = null;
  }
}

async function scanSPX() {
  try {
    if (activeTrade) {
      await monitorTrade();
      return;
    }

    const chain = await getSPXChain();
    const picked = pickBestSPXContract(chain);

    if (picked.error) {
      console.log('SPX:', picked.error);
      console.log({
        underlyingPrice: picked.underlyingPrice,
        totalContracts: picked.totalContracts,
        validContracts: picked.validContracts
      });
      return;
    }

    const c = picked.contract;

    if (sentContracts.has(c.ticker)) {
      console.log('تم تجاهل عقد مرسل سابقاً:', c.ticker);
      return;
    }

    console.log(`SPX ${c.side} ${c.ticker} score ${c.score}`);

    if (c.score >= MIN_SCORE) {
      await bot.sendMessage(ADMIN_CHAT_ID, buildEntryMessage(c, picked.underlyingPrice));
      sentContracts.add(c.ticker);
      openTrade(c);
    }
  } catch (err) {
    console.error('SPX ERROR:', err.response?.data || err.message);
  }
}

async function start() {
  console.log('SPX BOT STARTED');

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🚀 تم تشغيل بوت SPX الخاص

📊 الرمز: SPX
🔥 أقل درجة: ${MIN_SCORE}
📏 أعلى سبريد: ${MAX_SPREAD_PCT}%
💵 نطاق العقد: ${MIN_PREMIUM} إلى ${MAX_PREMIUM}
🔔 التحديث: كل +${n(PROFIT_STEP_PREMIUM)}

✅ البوت يختار عقد واحد فقط حسب قوة الكول أو البوت.`
  );

  await scanSPX();
  setInterval(scanSPX, SCAN_INTERVAL_MS);
}

start().catch(err => {
  console.error('BOT FATAL ERROR:', err.response?.data || err.message);
  process.exit(1);
});
