require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

if (!ADMIN_CHAT_ID) {
  console.error('Missing ADMIN_CHAT_ID');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

async function start() {
  console.log('HERO ZERO BOT STARTED');

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    '🚀 Hero Zero Bot Started\n\n✅ Telegram connection works.'
  );

  console.log('Telegram test message sent');
}

start().catch(err => {
  console.error('BOT ERROR:', err.message);
});
