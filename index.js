// ----- импорты -----
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios       = require('axios');
const cron        = require('node-cron');
const fs          = require('fs').promises;

// ----- переменные окружения -----
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;

if (!TELEGRAM_TOKEN || !YANDEX_API_KEY) {
  console.error('Нужно указать TELEGRAM_BOT_TOKEN и YANDEX_API_KEY в .env');
  process.exit(1);
}

// ----- инициализация бота -----
const bot = new Telegraf(TELEGRAM_TOKEN);

// ----- файл подписчиков -----
const SUB_FILE = 'subscriptions.json';
let subscribers = new Set();        // chat_id
const sentCache = new Set();        // защита от дублей: chatId|flightKey

async function loadSubs() {
  try {
    const data = await fs.readFile(SUB_FILE, 'utf-8');
    subscribers = new Set(JSON.parse(data));
  } catch { subscribers = new Set(); }
}

async function saveSubs() {
  await fs.writeFile(SUB_FILE, JSON.stringify([...subscribers], null, 2));
}

// ----- утилиты -----
function fmtTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// ----- Telegram-команды -----
bot.start(ctx => ctx.reply(
  'Привет! /subscribe — получать уведомления, /unsubscribe — отписаться.'
));

bot.command('subscribe', async ctx => {
  const id = ctx.chat.id;
  if (subscribers.has(id)) return ctx.reply('Вы уже подписаны ✔️');
  subscribers.add(id);
  await saveSubs();
  ctx.reply('Подписка оформлена! Буду оповещать за час до рейса.');
});

bot.command('unsubscribe', async ctx => {
  const id = ctx.chat.id;
  if (subscribers.delete(id)) {
    await saveSubs();
    ctx.reply('Вы отписались.');
  } else ctx.reply('Вы и так не были подписаны.');
});

bot.help(ctx => ctx.reply(
  '/subscribe — включить уведомления\n/unsubscribe — выключить\n/help — справка'
));

// ----- работа с Яндекс.Расписаниями -----
const STATION = 'GSV';       // IATA аэропорта Гагарин
const LANG    = 'ru_RU';

async function fetchFlights(event) {
  // event: 'departure' | 'arrival'
  const date = new Date().toISOString().split('T')[0];
  const url =
    `https://api.rasp.yandex.net/v3.0/schedule/?apikey=${YANDEX_API_KEY}` +
    `&station=${STATION}&system=iata&transport_types=plane&event=${event}` +
    `&date=${date}&lang=${LANG}&format=json`;
  const { data } = await axios.get(url);
  return data.schedule || data.result || [];
}

async function checkFlights() {
  const [departures, arrivals] = await Promise.all([
    fetchFlights('departure'),
    fetchFlights('arrival')
  ]);

  const now = new Date();
  const toSend = [];   // {msg, key}

  const scan = (list, type) => {
    list.forEach(f => {
      const timeStr = type === 'dep'
        ? (f.departure || f.departure_time)
        : (f.arrival   || f.arrival_time);
      if (!timeStr) return;

      const when = new Date(timeStr);
      const diff = Math.round((when - now) / 60000);   // в минутах
      if (diff !== 60) return;

      const num  = f.thread?.number || '???';
      const city = type === 'dep'
        ? (f.thread?.to?.title   || '')
        : (f.thread?.from?.title || '');

      const msg  = type === 'dep'
        ? `✈️ Рейс *${num}* вылетает в ${city} через час (в ${fmtTime(when)}).`
        : `🛬 Рейс *${num}* из ${city} прибудет через час (в ${fmtTime(when)}).`;

      toSend.push({ msg, key: `${type}|${num}|${when.toISOString()}` });
    });
  };

  scan(departures, 'dep');
  scan(arrivals,   'arr');

  for (const chatId of subscribers) {
    for (const { msg, key } of toSend) {
      const k = `${chatId}|${key}`;
      if (sentCache.has(k)) continue;       // уже слали
      await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        .catch(e => console.error('Ошибка отправки:', e));
      sentCache.add(k);
    }
  }
}

// ----- запуск -----
(async () => {
  await loadSubs();
  await bot.launch();
  console.log('Бот запущен. Подписчиков:', subscribers.size);

  // каждые 5 минут
  cron.schedule('*/5 * * * *', () => checkFlights().catch(console.error));
})();
