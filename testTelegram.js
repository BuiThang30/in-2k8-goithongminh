/**
 * Test bot Telegram (1 file duy nhất).
 *
 *   node testTelegram.js                     # gửi cảnh báo môi trường mẫu, đúng định dạng thật, thiết bị 1
 *   node testTelegram.js 2                   # cảnh báo mẫu cho thiết bị 2
 *   node testTelegram.js 1 humidity,noise    # chỉ vượt ngưỡng độ ẩm + tiếng ồn
 *   node testTelegram.js --ping              # chỉ gửi 1 tin thử (kiểm tra token + chat id)
 *   node testTelegram.js --ping "Nội dung"   # gửi nội dung tùy ý
 *   node testTelegram.js --find-chat-id      # liệt kê chat id của người đã nhắn cho bot
 *
 * Cảnh báo mẫu dùng ĐÚNG hàm cảnh báo của web (crudGenerator.js) và ngưỡng trong bảng
 * thresholds của thiết bị; chỉ chỉ số nào có giá trị mẫu CAO HƠN ngưỡng mới có trong tin.
 * Giờ trong tin nhắn là giờ Việt Nam (UTC+7).
 */
require('dotenv').config();
const TelegramBotPkg = require('node-telegram-bot-api');
const TelegramBot = TelegramBotPkg.default || TelegramBotPkg;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const args = process.argv.slice(2);

// Giá trị mẫu đủ lớn để vượt ngưỡng; muốn thử số khác thì sửa ở đây
const SAMPLE = { temperature: 35.0, humidity: 85.0, pm25: 80, co2: 1500, noise: 58.5, light: 450 };

const nowVN = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

function explainError(err) {
    const code = err.response && err.response.statusCode;
    const desc = err.response && err.response.body && err.response.body.description;
    console.error('Gửi thất bại:', desc || err.message);
    if (code === 401) console.error('-> Token sai hoặc đã bị thu hồi. Lấy lại token từ @BotFather.');
    if (code === 400 && /chat not found/i.test(desc || '')) console.error('-> Sai chat id, hoặc bạn chưa nhắn "/start" cho bot. Chạy: node testTelegram.js --find-chat-id');
    if (code === 403) console.error('-> Bot bị chặn hoặc bị đuổi khỏi nhóm. Mở lại bot và nhắn "/start".');
}

async function findChatId(bot) {
    const updates = await bot.getUpdates();
    if (!updates.length) {
        console.log('Chưa có tin nhắn nào. Hãy nhắn "/start" cho bot (hoặc thêm bot vào nhóm rồi nhắn 1 tin), sau đó chạy lại lệnh này.');
        return;
    }
    const seen = new Map();
    for (const u of updates) {
        const chat = (u.message || u.edited_message || u.channel_post || {}).chat;
        if (chat) seen.set(chat.id, chat);
    }
    for (const [id, c] of seen) {
        console.log(`chat id: ${id}  | loại: ${c.type}  | tên: ${c.title || c.username || c.first_name}`);
    }
}

async function ping(bot, text) {
    const sent = await bot.sendMessage(chatId, text || `Test bot Smart Pillow\nThời gian: ${nowVN()}`);
    console.log(`Đã gửi tin nhắn (message_id ${sent.message_id}) tới chat ${chatId}`);
}

async function sendAlert() {
    // require ở đây để chế độ --ping / --find-chat-id không cần mở database
    const { checkThresholdsAndAlert } = require('./crudGenerator');
    const db = require('./db');

    const deviceID = parseInt(args[0] ?? 1, 10);
    const only = args[1] ? args[1].split(',').map((s) => s.trim()) : null;
    const data = {};
    for (const key of Object.keys(SAMPLE)) data[key] = !only || only.includes(key) ? SAMPLE[key] : null;

    console.log(`Gửi cảnh báo thử cho thiết bị ${deviceID}:`, data);
    await checkThresholdsAndAlert(data, deviceID);
    setTimeout(() => db.close(), 1500);   // chờ gửi xong rồi đóng DB
}

(async () => {
    if (!token) { console.error('Thiếu TELEGRAM_BOT_TOKEN trong file .env'); process.exit(1); }
    try {
        if (args[0] === '--find-chat-id') {
            const bot = new TelegramBot(token);
            const me = await bot.getMe();
            console.log(`Bot hợp lệ: @${me.username}`);
            return await findChatId(bot);
        }

        if (!chatId) { console.error('Thiếu TELEGRAM_CHAT_ID trong file .env (chạy "node testTelegram.js --find-chat-id" để lấy)'); process.exit(1); }

        if (args[0] === '--ping') {
            const bot = new TelegramBot(token);
            const me = await bot.getMe();
            console.log(`Bot hợp lệ: @${me.username}`);
            return await ping(bot, args[1]);
        }

        await sendAlert();
    } catch (err) {
        explainError(err);
        process.exit(1);
    }
})();