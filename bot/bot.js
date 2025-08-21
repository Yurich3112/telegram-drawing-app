require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const sharedSecret = process.env.SHARED_SECRET_KEY; // unused now, kept for future
const appUrl = process.env.APP_BASE_URL;
const directLinkSlug = process.env.APP_DIRECT_LINK_SLUG || 'draw'; // BotFather Direct Link path

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
    const room = chatId;
    const url = makeAppUrl(room);
    const text = `Tap to open your canvas: <a href="${url}">Open here</a>`;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
});

bot.onText(/^\/draw(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;
    const isPrivate = chatType === 'private';

    if (isPrivate) {
        const url = makeAppUrl(chatId);
        const text = `Tap to open your canvas: <a href="${url}">Open here</a>`;
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
        return;
    }

    // Group: send startapp link using the configured direct-link slug to show a rich preview card
    const me = await bot.getMe();
    const startapp = makeStartAppPayload(chatId);
    const startAppLink = `https://t.me/${me.username}/${directLinkSlug}?startapp=${startapp}`;
    // Send as plain text so Telegram renders the preview card
    const text = `Launch Mini App: ${startAppLink}`;
    bot.sendMessage(chatId, text, { disable_web_page_preview: false }).catch(console.error);
});