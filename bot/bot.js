require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const sharedSecret = process.env.SHARED_SECRET_KEY;
const appUrl = process.env.APP_BASE_URL;

if (!token || !sharedSecret || !appUrl) {
    console.error("Missing critical environment variables. Check your .env file.");
    console.error({ hasToken: !!token, hasSecret: !!sharedSecret, hasAppUrl: !!appUrl });
    process.exit(1);
}

process.title = 'telegram-drawing-bot';

const bot = new TelegramBot(token, { polling: true });

// Exit fast if another instance is polling
bot.on('polling_error', (err) => {
    console.error('[polling_error]', err);
    if (err && err.code === 'ETELEGRAM' && /409/.test(String(err.message))) {
        console.error('Another instance is polling this bot. Exiting to prevent conflicts.');
        process.exit(1);
    }
});

console.log("🤖 Bot is running and waiting for commands...");

function makeUrlForRoom(room) {
    const secureToken = crypto.createHash('sha256').update(room + sharedSecret).digest('hex');
    const base = appUrl.replace(/\/+$/, '');
    return `${base}/?room=${encodeURIComponent(room)}&token=${secureToken}`;
}

function makeStartAppPayload(room) {
    // Keep it short and URL-safe. Prefix to distinguish.
    return encodeURIComponent('r_' + room);
}

// Support t.me link with /start startparam (optional)
bot.onText(/^\/start(?:\s+(.*))?$/, (msg, match) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;
    if (chatType !== 'private') return; // Only handle private /start
    const startParam = (match && match[1]) ? match[1].trim() : '';
    let room = chatId;
    if (startParam && startParam.startsWith('r_')) {
        const decoded = decodeURIComponent(startParam.slice(2));
        if (decoded) room = decoded;
    }
    const url = makeUrlForRoom(room);
    const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
    bot.sendMessage(chatId, 'Launch canvas:', options).catch(console.error);
});

// Match /draw with optional @Bot mention
bot.onText(/^\/draw(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type; // private, group, supergroup, channel
    const isPrivate = chatType === 'private';
    console.log(`Received /draw in chat ${chatId} (type=${chatType})`);

    const url = makeUrlForRoom(chatId);

    if (isPrivate) {
        const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }, { text: '🌐 Open in Browser', url }]] } };
        bot.sendMessage(chatId, 'Tap a button to open your shared canvas.', options).catch(err => console.error('sendMessage error:', err));
        return;
    }

    // Group: provide a public startapp link (opens the Mini App directly if supported by client)
    const me = await bot.getMe();
    const startapp = makeStartAppPayload(chatId);
    const startAppLink = `https://t.me/${me.username}/draw?startapp=${startapp}`;

    // Also DM fallback inline button
    const userId = msg.from && msg.from.id ? msg.from.id.toString() : null;
    if (userId) {
        try {
            const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
            await bot.sendMessage(userId, 'Open the group canvas here:', options);
        } catch (e) { /* ignore DM errors */ }
    }

    bot.sendMessage(chatId, `Launch Mini App: ${startAppLink}`).catch(console.error);
});