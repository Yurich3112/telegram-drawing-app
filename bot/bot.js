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
bot.on('inline_query', (query) => {
    const queryId = query.id;
    const roomName = query.query.trim();

    // Якщо користувач нічого не ввів після імені бота, нічого не робимо
    if (!roomName) {
        bot.answerInlineQuery(queryId, []).catch(console.error);
        return;
    }

    // Створюємо URL для нашого веб-додатку з назвою кімнати
    const url = makeRoomUrl(roomName);

    // Формуємо результат, який побачить користувач
    const results = [
        {
            type: 'article',
            id: '1', // Унікальний ID для цього результату
            title: `🎨 New Canvas "${roomName}"`,
            description: 'Collaborative mode allows everyone to draw simultaneously on the same board.',
            // Це те, що буде відправлено в чат, коли користувач натисне на результат
            input_message_content: {
                message_text: `Let's draw on the canvas: **${roomName}**!`,
                parse_mode: 'Markdown'
            },
            // А це найголовніше - кнопка, що відкриває Mini App
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🚀 Open Canvas',
                            web_app: { url: url }
                        }
                    ]
                ]
            },
            // Можна додати іконку для краси
            thumbnail_url: 'https://i.imgur.com/TZeA09j.png', // Приклад іконки, замініть на свою
            thumbnail_width: 64,
            thumbnail_height: 64
        }
    ];

    // Надсилаємо відповідь на запит Telegram
    bot.answerInlineQuery(queryId, results, { cache_time: 0 }).catch(console.error);
});