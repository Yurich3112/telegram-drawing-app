require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const sharedSecret = process.env.SHARED_SECRET_KEY;
const appUrl = process.env.APP_BASE_URL;

if (!token || !sharedSecret || !appUrl) {
    console.error("Missing critical environment variables. Check your .env file.");
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

// Match /draw with optional @Bot mention
bot.onText(/^\/draw(?:@\w+)?$/, (msg) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type; // private, group, supergroup, channel
    const isPrivate = chatType === 'private';
    console.log(`Received /draw in chat ${chatId} (type=${chatType})`);

    const secureToken = crypto.createHash('sha256').update(chatId + sharedSecret).digest('hex');
    const base = appUrl.replace(/\/+$/, ''); // remove trailing slashes
    const privateUrl = `${base}/?room=${encodeURIComponent(chatId)}&token=${secureToken}`;
    console.log(`Generated Mini App URL: ${privateUrl}`);

    // In groups, Telegram API forbids web_app buttons in inline keyboards → use URL button only
    const inlineKeyboard = isPrivate
        ? [[
            { text: '🎨 Open Here', web_app: { url: privateUrl } },
            { text: '🌐 Open in Browser', url: privateUrl }
          ]]
        : [[
            { text: '🌐 Open Canvas', url: privateUrl }
          ]];

    const options = { reply_markup: { inline_keyboard: inlineKeyboard } };

    bot.sendMessage(chatId, isPrivate ? 'Tap a button to open your shared canvas.' : 'Tap to open your chat canvas in the browser.', options)
       .catch(err => console.error('sendMessage error:', err));
});