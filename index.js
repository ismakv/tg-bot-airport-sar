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

// Добавляем обработчики ошибок
bot.catch((err, ctx) => {
  console.error('Ошибка в обработчике:', err);
});

// Добавляем обработчик для всех обновлений
bot.use((ctx, next) => {
  console.log('Получено обновление:', ctx.updateType);
  return next();
});

// Функция запуска бота с таймаутом
async function launchBot() {
  return Promise.race([
    bot.launch(),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Таймаут запуска бота (30 секунд)'));
      }, 30000);
    })
  ]);
}

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
  return date.toLocaleTimeString('ru-RU', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Europe/Saratov'
  });
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
    console.log('checkFlights');
  const [departures, arrivals] = await Promise.all([
    fetchFlights('departure'),
    fetchFlights('arrival')
  ]);

  const now = new Date();
  // Преобразуем текущее время в зону Саратова
  const saratovOffset = 4; // UTC+4
  const utcOffset = now.getTimezoneOffset();
  const saratovNow = new Date(now.getTime() + (utcOffset + saratovOffset * 60) * 60000);
  
  const toSend = [];   // {msg, key}

  const scan = (list, type) => {
    list.forEach(f => {
      const timeStr = type === 'dep'
        ? (f.departure || f.departure_time)
        : (f.arrival   || f.arrival_time);
      if (!timeStr) return;

      const when = new Date(timeStr);
      const diff = Math.round((when - saratovNow) / 60000);   // в минутах
      
      // Не показываем прошедшие рейсы и рейсы более чем за 65 минут
      if (diff < 0 || diff > 65) return;

      const num  = f.thread?.number || '???';
      const city = type === 'dep'
        ? (f.thread?.to?.title   || '')
        : (f.thread?.from?.title || '');

      let msg;
      if (diff >= 55 && diff <= 65) {
        // Стандартное уведомление за час
        msg = type === 'dep'
          ? `✈️ Рейс *${num}* вылетает в ${city} через час (в ${fmtTime(when)}).`
          : `🛬 Рейс *${num}* из ${city} прибудет через час (в ${fmtTime(when)}).`;
      } else {
        // Срочное уведомление если осталось меньше часа
        const minutes = Math.max(diff, 0);
        msg = type === 'dep'
          ? `⚠️ Скоро вылет! Рейс *${num}* вылетает в ${city} через ${minutes} мин (в ${fmtTime(when)}).`
          : `⚠️ Скоро прилет! Рейс *${num}* из ${city} прибудет через ${minutes} мин (в ${fmtTime(when)}).`;
      }

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
  try {
    console.log('start');
    
    // Проверяем токены
    console.log('TELEGRAM_TOKEN exists:', !!TELEGRAM_TOKEN);
    console.log('YANDEX_API_KEY exists:', !!YANDEX_API_KEY);
    
    try {
      await loadSubs();
      console.log('Подписчики загружены');
    } catch (e) {
      console.error('Ошибка при загрузке подписчиков:', e);
      subscribers = new Set();
    }

    console.log('Пробуем запустить бота...');
    
    // Запускаем бота
    bot.launch()
      .then(() => {
        console.log('bot.launch() выполнен успешно');
      })
      .catch(err => {
        console.error('Ошибка при запуске бота:', err);
        throw err;
      });
      
    console.log('Бот запущен. Подписчиков:', subscribers.size);

    // Включаем graceful shutdown
    process.once('SIGINT', () => {
      console.log('SIGINT');
      bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      console.log('SIGTERM');
      bot.stop('SIGTERM');
    });

    // Настраиваем cron
    console.log('Настраиваем cron...');
    cron.schedule('*/10 * * * *', () => {
      console.log('Cron: запускаем checkFlights');
      checkFlights().catch(e => console.error('Ошибка в checkFlights:', e));
    });
    console.log('Cron настроен');

  } catch (e) {
    console.error('Критическая ошибка:', e);
    process.exit(1);
  }
})().catch(e => {
  console.error('Необработанная ошибка:', e);
  process.exit(1);
});
