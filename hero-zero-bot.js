require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

const HERO_SYMBOLS = String(process.env.HERO_SYMBOLS || 'SPY,QQQ,TSLA,META,AAPL')
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const MIN_HERO_SCORE = Number(process.env.MIN_HERO_SCORE || 88);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT || 12);
const MAX_MOVE_FROM_OPEN = Number(process.env.MAX_MOVE_FROM_OPEN || 2.5);

const MIN_VOLUME = Number(process.env.MIN_VOLUME || 500);
const MIN_OPEN_INTEREST = Number(process.env.MIN_OPEN_INTEREST || 500);
const MIN_VOLUME_OI_RATIO = Number(process.env.MIN_VOLUME_OI_RATIO || 1.2);

const MIN_PREMIUM = Number(process.env.MIN_PREMIUM || 0.15);
const MAX_PREMIUM = Number(process.env.MAX_PREMIUM || 1.20);

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60 * 1000);

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID');
if (!FINNHUB_API_KEY) throw new Error('Missing FINNHUB_API_KEY');
if (!MASSIVE_API_KEY) throw new Error('Missing MASSIVE_API_KEY');

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const sentKeys = new Set();

// =====================
// Helpers
// =====================
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
  if (!Number.isFinite(x)) return 'N/A';
  return x.toFixed(digits);
}

function pct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 'N/A';
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

  // Spread: 20
  if (spreadPct !== null && spreadPct <= 6) score += 20;
  else if (spreadPct !== null && spreadPct <= 9) score += 16;
  else if (spreadPct !== null && spreadPct <= MAX_SPREAD_PCT) score += 12;

  // Volume: 20
  if (volume >= 3000) score += 20;
  else if (volume >= 1500) score += 16;
  else if (volume >= MIN_VOLUME) score += 12;

  // OI: 15
  if (openInterest >= 3000) score += 15;
  else if (openInterest >= 1500) score += 12;
  else if (openInterest >= MIN_OPEN_INTEREST) score += 9;

  // Volume/OI: 20
  if (volumeOiRatio >= 3) score += 20;
  else if (volumeOiRatio >= 2) score += 16;
  else if (volumeOiRatio >= MIN_VOLUME_OI_RATIO) score += 12;

  // Premium: 15
  if (premium >= 0.25 && premium <= 0.90) score += 15;
  else if (premium >= MIN_PREMIUM && premium <= MAX_PREMIUM) score += 10;

  // Move from open: 10
  if (moveFromOpenAbs <= 1.2) score += 10;
  else if (moveFromOpenAbs <= MAX_MOVE_FROM_OPEN) score += 6;

  return score;
}

// =====================
// Finnhub
// =====================
async function getStockQuote(symbol) {
  const url = 'https://finnhub.io/api/v1/quote';
  const { data } = await axios.get(url, {
    params: {
      symbol,
      token: FINNHUB_API_KEY
    },
    timeout: 15000
  });

  const price = Number(data.c);
  const open = Number(data.o);
  const previousClose = Number(data.pc);

  if (!(price > 0)) throw new Error(`No Finnhub price for ${symbol}`);

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

// =====================
// Massive Option Chain
// =====================
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

  const results = Array.isArray(data.results) ? data.results : [];

  return results;
}

function normalizeContract(row) {
  const details = row.details || {};
  const quote = row.last_quote || {};
  const trade = row.last_trade || {};
  const greeks = row.greeks || {};

  const strike = Number(details.strike_price);
  const side = String(details.contract_type || '').toUpperCase(); // call / put
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
    gamma: greeks.gamma,
    raw: row
  };
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

  const calls = normalized
    .filter(c => c.side === 'CALL' && c.strike > stockPrice)
    .sort((a, b) => a.strike - b.strike);

  const puts = normalized
    .filter(c => c.side === 'PUT' && c.strike < stockPrice)
    .sort((a, b) => b.strike - a.strike);

  const candidates = [];

  if (calls[0]) candidates.push(calls[0]);
  if (puts[0]) candidates.push(puts[0]);

  return candidates.map(c => ({
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
}

function buildAlert(symbol, quote, c) {
  const sideEmoji = c.side === 'CALL' ? '🟢' : '🔴';
  const strikeText = `${c.strike}${c.side === 'CALL' ? 'C' : 'P'}`;

  return `
🚀 HERO ZERO ALERT

📊 ${symbol}
${sideEmoji} ${c.side} ${strikeText} 0DTE

💵 Stock Price: ${n(quote.price)}
📈 Change: ${pct(quote.changePct)}
📌 Move From Open: ${pct(quote.moveFromOpen)}

━━━━━━━━━━━━━━
🎯 Contract
━━━━━━━━━━━━━━
Ticker: ${c.ticker}
Bid: ${n(c.bid)}
Ask: ${n(c.ask)}
Premium: ${n(c.premium)}

Spread: ${pct(c.spreadPct)}
Volume: ${Math.round(c.volume).toLocaleString()}
Open Interest: ${Math.round(c.openInterest).toLocaleString()}
Vol/OI: ${n(c.volumeOiRatio, 2)}x

━━━━━━━━━━━━━━
🔥 Hero Score: ${c.score}/100
━━━━━━━━━━━━━━

TP1: ${n(c.premium * 1.5)} (+50%)
TP2: ${n(c.premium * 2.0)} (+100%)
TP3: ${n(c.premium * 3.0)} (+200%)
SL: ${n(c.premium * 0.65)} (-35%)

⚠️ Hero Zero عالي المخاطرة.
`.trim();
}

// =====================
// Scanner
// =====================
async function scanSymbol(symbol) {
  try {
    const quote = await getStockQuote(symbol);

    const moveAbs = Math.abs(Number(quote.moveFromOpen || 0));

    if (moveAbs > MAX_MOVE_FROM_OPEN) {
      console.log(`${symbol}: skipped move from open ${moveAbs.toFixed(2)}%`);
      return;
    }

    const chain = await getOptionChain(symbol);

    if (!chain.length) {
      console.log(`${symbol}: no option chain`);
      return;
    }

    const candidates = pickBestContracts(symbol, quote.price, chain, moveAbs);

    if (!candidates.length) {
      console.log(`${symbol}: no valid hero contracts`);
      return;
    }

    for (const c of candidates) {
      const key = `${todayET()}_${symbol}_${c.ticker}`;

      if (sentKeys.has(key)) continue;

      console.log(`${symbol} ${c.side} ${c.ticker} score ${c.score}`);

      if (c.score >= MIN_HERO_SCORE) {
        await bot.sendMessage(ADMIN_CHAT_ID, buildAlert(symbol, quote, c));
        sentKeys.add(key);
      }
    }
  } catch (err) {
    console.error(`${symbol} ERROR:`, err.response?.data || err.message);
  }
}

async function scanAll() {
  console.log(`Scanning: ${HERO_SYMBOLS.join(', ')}`);

  for (const symbol of HERO_SYMBOLS) {
    await scanSymbol(symbol);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`Next scan after ${Math.round(SCAN_INTERVAL_MS / 1000)} seconds`);
}

// =====================
// Start
// =====================
async function start() {
  console.log('HERO ZERO BOT STARTED');

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🚀 Hero Zero Bot Started

Symbols: ${HERO_SYMBOLS.join(', ')}
Min Score: ${MIN_HERO_SCORE}
Max Spread: ${MAX_SPREAD_PCT}%
Max Move From Open: ${MAX_MOVE_FROM_OPEN}%`
  );

  await scanAll();

  setInterval(scanAll, SCAN_INTERVAL_MS);
}

start().catch(err => {
  console.error('BOT FATAL ERROR:', err.response?.data || err.message);
  process.exit(1);
});
