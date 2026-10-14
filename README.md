# meet — запись на встречу к Javokhir

**Live:** https://javokhirkomiljanov.github.io/meet/
**Бэкенд:** Apps Script «meet booking» в javohirdiamond06@gmail.com, деплой «meet booking v1» (URL в `index.html` → `window.MEET_API`).

Страница в стиле W2W (белый/мятный, Manrope), где клиент сам бронирует 30 / 45 / 60 минут — онлайн (Google Meet) или офлайн.
Свободные окна берутся из Google Calendar в реальном времени, бронь сразу создаёт событие в календаре.

```
index.html              страница (один файл, без сборки) — GitHub Pages
apps-script/Code.gs     бэкенд: Google Apps Script web app (слоты + бронь)
apps-script/appsscript.json
test/                   node test/gas-test.js — 17 тестов логики бэкенда; node test/mock-server.js — локальный стенд
og.png                  превью ссылки в Telegram
```

## Как это работает

- Страница при загрузке одним запросом берёт занятые интервалы из календарей (`BUSY_CALENDARS`) и сама строит сетку слотов по рабочим часам.
- Блокируют слот: любые события с временем (включая помеченные «свободен», например намазы) ± буфер 15 мин. Весь день-события и отклонённые приглашения — не блокируют.
- Бронь: бэкенд под локом ещё раз проверяет слот (двойной брони не будет), создаёт событие «Javokhir × {Имя} — 30 daq (Online)» с Google Meet. Если клиент указал email — ему уходит приглашение.
- Без бэкенда (`MEET_API` пустой или недоступен) страница не ломается: подтверждение уходит готовым сообщением в Telegram.

## Подключить календарь (один раз, ~2 минуты)

1. Открыть https://script.new под **javohirdiamond06@gmail.com** (бронь ляжет в основной календарь этого аккаунта).
2. Удалить всё в `Code.gs`, вставить `apps-script/Code.gs`. Сохранить (Ctrl+S), назвать проект `meet`.
   Слева **Services → + → Google Calendar API (v3) → Add**. Без этого Google отвечает 403 на чтение календаря и все слоты кажутся свободными.
3. Вверху выбрать функцию `selfTest` → **Run** → Review permissions → аккаунт → Advanced → *Go to meet (unsafe)* → **Allow**.
   В логе появятся занятые интервалы — значит календарь читается.
4. **Deploy → New deployment** → ⚙ **Web app** → Execute as: **Me**, Who has access: **Anyone** → Deploy → скопировать URL `…/exec`.
5. В `index.html` вписать: `window.MEET_API = 'https://script.google.com/macros/s/…/exec';` → commit → push.

Правки `Code.gs` потом: Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy (URL не меняется).

## Настройки (`CFG` в Code.gs)

| Что | По умолчанию |
|---|---|
| Рабочие часы (Ташкент) | Пн–Пт 10:00–19:00, Сб 10:00–15:00, Вс — нет |
| Длительности | 30 / 45 / 60 мин, сетка 30 мин |
| Буфер вокруг событий | 15 мин |
| Минимум до встречи | 3 часа |
| Горизонт | 21 день |
| Календари занятости | primary + javokhir.k@alliancevs.io (если читается) |
| Адрес офлайн-встреч | пусто → «адрес пришлю с подтверждением» |
| Антиспам | 2 брони на контакт за 6 ч, 25 в день, honeypot |

Telegram-пинг о каждой брони (опционально): Project Settings → Script properties → `TG_BOT_TOKEN`, `TG_CHAT_ID`.
Токены только туда — в репозитории их нет и быть не должно.

## Ссылки-пресеты

- `?lang=ru` / `?lang=en` — язык (по умолчанию узбекский)
- `?d=60` — сразу 60 минут, `?m=offline` — сразу офлайн
- пример: `https://javokhirkomiljanov.github.io/meet/?lang=ru&d=60`
