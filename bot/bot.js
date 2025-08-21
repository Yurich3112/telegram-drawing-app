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

const bot = new TelegramBot(token, { polling: true });

console.log("🤖 Bot is running and waiting for commands...");

bot.onText(/\/draw/, (msg) => {
    const chatId = msg.chat.id.toString();
    console.log(`Received /draw command from chat ID: ${chatId}`);

    const secureToken = crypto.createHash('sha256').update(chatId + sharedSecret).digest('hex');
    const privateUrl = `${appUrl}/?room=${chatId}&token=${secureToken}`;
    console.log(`Generated Mini App URL: ${privateUrl}`);

    // --- THE KEY CHANGE IS HERE ---
    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎨 Open Drawing Canvas!',
                        // Instead of a 'url' field, we use a 'web_app' object
                        web_app: {
                            url: privateUrl
                        }
                    }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, "Click the button below to open our shared canvas inside Telegram:", options);
});