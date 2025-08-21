require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const sharedSecret = process.env.SHARED_SECRET_KEY; // unused now, kept for future
const appUrl = process.env.APP_BASE_URL;

if (!token || !appUrl) {
    console.error("Missing critical environment variables. Check your .env file.");
    console.error({ hasToken: !!token, hasAppUrl: !!appUrl });
    process.exit(1);
}

process.title = 'telegram-drawing-bot';

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    console.error('[polling_error]', err);
    if (err && err.code === 'ETELEGRAM' && /409/.test(String(err.message))) {
        console.error('Another instance is polling this bot. Exiting to prevent conflicts.');
        process.exit(1);
    }
});

console.log("🤖 Bot is running and waiting for commands...");

function makeAppUrl(room) {
    const base = appUrl.replace(/\/+$/, '');
    return `${base}/?room=${encodeURIComponent(room)}`;
}

function makeStartAppPayload(room) {
    return encodeURIComponent('r_' + room);
}

bot.onText(/^\/start(?:\s+(.*))?$/, (msg, match) => {
    const chatId = msg.chat.id.toString();
    if (msg.chat.type !== 'private') return;
    // By default open personal room in private chat
    const room = chatId;
    const url = makeAppUrl(room);
    const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
    bot.sendMessage(chatId, 'Launch canvas:', options).catch(console.error);
});

bot.onText(/^\/draw(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;
    const isPrivate = chatType === 'private';

    if (isPrivate) {
        const url = makeAppUrl(chatId);
        const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
        bot.sendMessage(chatId, 'Tap to open your canvas.', options).catch(console.error);
        return;
    }

    // Group: send canonical startapp link
    const me = await bot.getMe();
    const startapp = makeStartAppPayload(chatId);
    const startAppLink = `https://t.me/${me.username}?startapp=${startapp}`;
    bot.sendMessage(chatId, `Launch Mini App: ${startAppLink}`).catch(console.error);
});