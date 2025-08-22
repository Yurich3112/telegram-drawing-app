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
const botUsername = process.env.TELEGRAM_BOT_USERNAME;
if (!botUsername) {
    console.error("TELEGRAM_BOT_USERNAME is not set in your .env file!");
    process.exit(1);
}

// Функція-помічник для екранування HTML-тегів у тексті від користувача
function escapeHtml(text) {
    return text
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;");
}


// Функція-помічник для екранування HTML-тегів
function escapeHtml(text) {
    return text
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;");
}

bot.on('inline_query', (query) => {
    const queryId = query.id;
    const roomName = query.query.trim();

    if (!roomName) {
        bot.answerInlineQuery(queryId, [{
            type: 'article',
            id: 'hint',
            title: 'Enter a canvas name',
            input_message_content: { message_text: 'Please enter a name for the canvas.' }
        }], { cache_time: 10 }).catch(console.error);
        return;
    }

    // --- ЗМІНА №1: Створюємо унікальний ID для кімнати ---
    // Генеруємо короткий випадковий рядок (наприклад, 'a1b2c3')
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    // Створюємо фінальний ID кімнати, який буде унікальним
    const uniqueRoomId = `${roomName}-${uniqueSuffix}`;

    const startAppPayload = makeStartAppPayload(uniqueRoomId);
    const appDirectUrl = `https://t.me/${botUsername}/draw?startapp=${startAppPayload}`;

    // Екрануємо назву для безпечного використання в HTML
    const safeRoomName = escapeHtml(roomName);
    // Екрануємо URL для безпечного використання в атрибуті href
    const safeUrl = escapeHtml(appDirectUrl);

    const results = [
        {
            type: 'article',
            id: uniqueSuffix, // Використовуємо наш унікальний суфікс як ID результату
            title: `🎨 New Board "${roomName}"`,
            description: 'A unique canvas will be created for you and your friends.',
            
            input_message_content: {
                // --- ЗМІНА №2: Робимо назву клікабельним посиланням ---
                message_text: `Board: <b><a href="${safeUrl}">${safeRoomName}</a></b>`,
                parse_mode: 'HTML',
                // Вимикаємо попередній перегляд самого посилання, бо воно вже вбудоване
                disable_web_page_preview: false
            },
            
            thumbnail_url: 'https://raw.githubusercontent.com/Yurich3112/telegram-drawing-app/refs/heads/main/images/a-color-palet-with-paint-brushes%20(1).png'
        }
    ];

    bot.answerInlineQuery(queryId, results, { cache_time: 0 }).catch(console.error);
});