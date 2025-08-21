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

// Support t.me link with /start startparam (optional)
bot.onText(/^\/start(?:\s+(.*))?$/, (msg, match) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;
    if (chatType !== 'private') return; // Only handle private /start
    const startParam = (match && match[1]) ? match[1].trim() : '';
    // If startParam carries a room id (e.g., r_<encodedRoom>), open that room; else default to user's private chat
    let room = chatId;
    if (startParam && startParam.startsWith('r_')) {
        const decoded = decodeURIComponent(startParam.slice(2));
        if (decoded) room = decoded;
    }
    const url = makeUrlForRoom(room);
    const options = {
        reply_markup: {
            inline_keyboard: [[
                { text: '🎨 Open Here', web_app: { url } }
            ]]
        }
    };
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
        // Private chat: inline keyboard web_app is allowed
        const options = {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎨 Open Here', web_app: { url } },
                    { text: '🌐 Open in Browser', url }
                ]]
            }
        };
        bot.sendMessage(chatId, 'Tap a button to open your shared canvas.', options)
           .catch(err => console.error('sendMessage error:', err));
        return;
    }

    // Group/supergroup workaround: DM the user a private web_app button to launch the Mini App
    const userId = msg.from && msg.from.id ? msg.from.id.toString() : null;
    if (!userId) return;

    const deepLink = `https://t.me/${(await bot.getMe()).username}?start=${encodeURIComponent('r_' + chatId)}`;

    // Send an inline web_app to the user's private chat; if user hasn't started the bot, send a deep link
    try {
        const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
        await bot.sendMessage(userId, 'Open the group canvas here:', options);
        await bot.sendMessage(chatId, `I sent you a private message with the launch button. If you can't see it, tap: ${deepLink}`);
    } catch (e) {
        console.error('DM send error:', e);
        // If DM fails (user never started the bot), send deep link only
        await bot.sendMessage(chatId, `Please start me in private first, then tap: ${deepLink}`).catch(console.error);
    }
});