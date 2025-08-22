require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.APP_BASE_URL;

if (!token || !appUrl) {
    console.error("Missing critical environment variables. Check your .env file.");
    process.exit(1);
}

process.title = 'telegram-drawing-bot';

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    console.error('[polling_error]', err);
    if (err && err.code === 'ETELEGRAM' && /409/.test(String(err.message))) {
        process.exit(1);
    }
});

console.log("🤖 Bot is running and waiting for commands...");

function makeRoomUrl(room) {
    const base = appUrl.replace(/\/+$/, '');
    return `${base}/?room=${encodeURIComponent(room)}`;
}

function makeStartAppPayload(room) {
    return encodeURIComponent('r_' + room);
}

bot.onText(/^\/start(?:\s+(.*))?$/, (msg, match) => {
    const chatId = msg.chat.id.toString();
    if (msg.chat.type !== 'private') return;
    const startParam = (match && match[1]) ? match[1].trim() : '';
    let room = chatId;
    if (startParam && startParam.startsWith('r_')) {
        const decoded = decodeURIComponent(startParam.slice(2));
        if (decoded) room = decoded;
    }
    const url = makeRoomUrl(room);
    const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }, { text: '🌐 Open in Browser', url }]] } };
    bot.sendMessage(chatId, 'Launch canvas:', options).catch(console.error);
});

bot.onText(/^\/draw(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const isPrivate = msg.chat.type === 'private';
    const url = makeRoomUrl(chatId);

    if (isPrivate) {
        const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }, { text: '🌐 Open in Browser', url }]] } };
        bot.sendMessage(chatId, 'Tap a button to open your shared canvas.', options).catch(console.error);
        return;
    }

    const me = await bot.getMe();
    const startapp = makeStartAppPayload(chatId);
    const startAppLink = `https://t.me/${me.username}?startapp=${startapp}`;

    // DM fallback inline button
    const userId = msg.from && msg.from.id ? msg.from.id.toString() : null;
    if (userId) {
        try {
            const options = { reply_markup: { inline_keyboard: [[{ text: '🎨 Open Here', web_app: { url } }]] } };
            await bot.sendMessage(userId, 'Open the group canvas here:', options);
        } catch {}
    }

    bot.sendMessage(chatId, `Launch Mini App: ${startAppLink}`).catch(console.error);
});

// --- НОВИЙ КОД: Обробка inline-запитів ---
// Отримайте ім'я користувача бота з env-змінних
const botUsername = process.env.TELEGRAM_BOT_USERNAME;
if (!botUsername) {
    console.error("TELEGRAM_BOT_USERNAME is not set in your .env file!");
    process.exit(1);
}

bot.on('inline_query', (query) => {
    const queryId = query.id;
    const roomName = query.query.trim();

    if (!roomName) {
        // Якщо запит порожній, показуємо підказку
        bot.answerInlineQuery(queryId, [{
            type: 'article',
            id: 'hint',
            title: 'Enter a canvas name',
            input_message_content: {
                message_text: 'Please enter a name for the canvas after mentioning the bot.'
            }
        }], { cache_time: 10 }).catch(console.error);
        return;
    }

    // Створюємо payload для deep-link. Ваш script.js очікує 'r_ROOMNAME'
    const startAppPayload = makeStartAppPayload(roomName);
    
    // Формуємо пряме посилання на Mini App
    // Формат: https://t.me/USERNAME_BOT/APP_SHORT_NAME?startapp=PAYLOAD
    // APP_SHORT_NAME - це те, що ви вказали в BotFather (наприклад, 'draw')
    const appDirectUrl = `https://t.me/${botUsername}/draw?startapp=${startAppPayload}`;

    const results = [
        {
            type: 'article',
            id: '1',
            title: `🎨 New Board "${roomName}"`,
            description: 'Collaborative mode allows everyone to draw simultaneously on the same board.',
            
            // Ось магія: ми просто надсилаємо повідомлення з прямим посиланням.
            // Telegram сам створить гарний попередній перегляд з кнопкою.
            input_message_content: {
                message_text: `Board "**${roomName}**"\n${appDirectUrl}`,
                parse_mode: 'Markdown'
            },
            
            // Нам більше не потрібен reply_markup тут
            
            thumbnail_url: 'https://i.imgur.com/TZeA09j.png' // Ваша іконка
        }
    ];

    bot.answerInlineQuery(queryId, results, { cache_time: 0 }).catch(console.error);
});