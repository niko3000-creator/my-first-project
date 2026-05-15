require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Ошибка: BOT_TOKEN не задан в .env файле');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const timers = new Map();

function loadReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveReminders(data) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function parseTime(str) {
  const now = new Date();
  str = str.trim();

  // 15:30
  let m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const dt = new Date(now);
    dt.setHours(+m[1], +m[2], 0, 0);
    if (dt <= now) dt.setDate(dt.getDate() + 1);
    return dt;
  }

  // 30m, 2h, 1h30m, 30м, 2ч, 1ч30м
  m = str.match(/^(?:(\d+)[hч])?(?:(\d+)[mм])?$/i);
  if (m && (m[1] || m[2])) {
    const h = +(m[1] || 0), min = +(m[2] || 0);
    if (h + min > 0) return new Date(now.getTime() + (h * 60 + min) * 60000);
  }

  // через N минут/часов
  m = str.match(/через\s+(\d+)\s*(минут|мин|час|часа|часов|ч)/i);
  if (m) {
    const n = +m[1];
    const isHour = /^(час|часа|часов|ч)$/i.test(m[2]);
    return new Date(now.getTime() + n * (isHour ? 3600000 : 60000));
  }

  return null;
}

function scheduleReminder(id, reminder) {
  const delay = new Date(reminder.remindAt) - Date.now();
  if (delay <= 0) {
    const data = loadReminders();
    if (data[reminder.chatId]) delete data[reminder.chatId][id];
    saveReminders(data);
    return;
  }

  const timer = setTimeout(async () => {
    try {
      await bot.sendMessage(reminder.chatId, `🔔 Напоминание!\n\n${reminder.task}`);
    } catch (e) {
      console.error('Не удалось отправить напоминание:', e.message);
    }
    const data = loadReminders();
    if (data[reminder.chatId]) delete data[reminder.chatId][id];
    saveReminders(data);
    timers.delete(id);
  }, delay);

  timers.set(id, timer);
}

function init() {
  const data = loadReminders();
  for (const chatId in data) {
    for (const id in data[chatId]) {
      scheduleReminder(id, data[chatId][id]);
    }
  }
}

const HELP = `Привет! Я бот-напоминалка. 🔔

*Команды:*
/remind <время> <задача> — поставить напоминание
/list — список напоминаний
/cancel <id> — отменить напоминание

*Форматы времени:*
• \`15:30\` — в конкретное время (завтра, если уже прошло)
• \`30m\` или \`30м\` — через 30 минут
• \`2h\` или \`2ч\` — через 2 часа
• \`1h30m\` — через 1 час 30 минут
• \`через 30 минут\` — текстом

*Примеры:*
/remind 15:30 Позвонить клиенту
/remind 30m Выпить воды
/remind 2h Проверить почту
/remind через 45 минут Сделать зарядку`;

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' });
});

bot.onText(/\/remind (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();

  let timeStr, task;

  // "через N слово задача"
  const viaMatch = input.match(/^(через\s+\d+\s+\S+)\s+(.+)$/i);
  if (viaMatch) {
    timeStr = viaMatch[1];
    task = viaMatch[2];
  } else {
    const parts = input.split(/\s+/);
    timeStr = parts[0];
    task = parts.slice(1).join(' ');
  }

  if (!task) {
    return bot.sendMessage(chatId, 'Укажи задачу.\nПример: /remind 15:30 Позвонить клиенту');
  }

  const remindAt = parseTime(timeStr);
  if (!remindAt) {
    return bot.sendMessage(chatId,
      `Не понял время: *${timeStr}*\nПопробуй: 15:30, 30m, 2h, 1h30m`,
      { parse_mode: 'Markdown' }
    );
  }

  const data = loadReminders();
  if (!data[chatId]) data[chatId] = {};
  const id = genId();
  data[chatId][id] = { chatId, task, remindAt: remindAt.toISOString() };
  saveReminders(data);
  scheduleReminder(id, data[chatId][id]);

  const fmt = remindAt.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  bot.sendMessage(chatId, `✅ Напомню ${fmt}:\n${task}`);
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const data = loadReminders();
  const entries = Object.entries(data[chatId] || {});

  if (!entries.length) {
    return bot.sendMessage(chatId, 'Нет активных напоминаний.');
  }

  entries.sort((a, b) => new Date(a[1].remindAt) - new Date(b[1].remindAt));

  const lines = ['📋 *Активные напоминания:*\n'];
  for (const [id, r] of entries) {
    const dt = new Date(r.remindAt).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    lines.push(`🕐 *${dt}* — ${r.task}\nID: \`${id}\``);
  }
  lines.push('\n_Отменить: /cancel <id>_');
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = match[1].trim();
  const data = loadReminders();

  if (!data[chatId]?.[id]) {
    return bot.sendMessage(chatId,
      `Напоминание \`${id}\` не найдено.\nПосмотри список: /list`,
      { parse_mode: 'Markdown' }
    );
  }

  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  delete data[chatId][id];
  saveReminders(data);
  bot.sendMessage(chatId, '❌ Напоминание отменено.');
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

init();
console.log('Бот запущен. Нажми Ctrl+C для остановки.');
