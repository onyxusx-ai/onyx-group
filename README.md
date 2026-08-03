# ONYX GROUP — готовый живой каталог китайских маркетплейсов

В проекте сохранён полный сайт ONYX GROUP. Новая витрина показывает **точные фотографии из конкретного объявления**, но владелец не скачивает их вручную:

1. расширение или закладка считывает карточку товара;
2. Cloudflare Worker получает исходные URL фотографий;
3. Worker автоматически копирует байты фотографий в R2;
4. GitHub Pages загружает стабильные фотографии из хранилища ONYX.

## Что находится в проекте

- `site/` — готовый сайт для GitHub Pages;
- `site/admin.html` — импорт, удаление товаров и Safari-закладка;
- `worker/` — Cloudflare Worker + R2 API;
- `extension/` — расширение Chrome / Edge / Opera / Яндекс.Браузера;
- `tests/` — автоматические проверки;
- `scripts/configure-site.mjs` — вставляет адрес Worker в сайт.

## Контакты сайта

- Email: `onyxshopmail@gmail.com`
- Telegram-канал: `@onyxgrouptg`
- Telegram-администратор: `@onyxgroupadmin`

## 1. Развернуть Worker и хранилище

Нужны Node.js и бесплатный аккаунт Cloudflare.

### macOS / Linux

```bash
./scripts/deploy-worker.sh
```

### Вручную

```bash
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create onyx-group-storage
npx wrangler r2 bucket create onyx-group-storage-dev
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Команда deploy покажет адрес вроде:

```text
https://onyx-group-catalog.<account>.workers.dev
```

`ADMIN_TOKEN` — длинный секрет, известный только администратору. Он не помещается в публичный HTML.

## 2. Подключить сайт к Worker

Из корня проекта:

```bash
node scripts/configure-site.mjs https://onyx-group-catalog.<account>.workers.dev
```

После этого загрузи **содержимое папки `site/`** в GitHub-репозиторий. Главный файл должен называться `index.html`.

## 3. Установить импортёр в Chromium-браузер

1. Открой страницу расширений браузера.
2. Включи режим разработчика.
3. Выбери «Загрузить распакованное расширение».
4. Укажи папку `extension/`.
5. Открой расширение и один раз сохрани Worker URL и `ADMIN_TOKEN`.

Дальше открой конкретное объявление на AliExpress, Alibaba, 1688, Taobao, Tmall, Pinduoduo или Poizon и нажми расширение. Оно покажет найденные фотографии и добавит их в ONYX.

## 4. Импорт в Safari без расширения

1. Открой опубликованный `admin.html`.
2. Сохрани Worker URL и `ADMIN_TOKEN`.
3. Перетащи кнопку «＋ Добавить товар в ONYX» на панель закладок.
4. Открой карточку товара на площадке.
5. Нажми эту закладку.
6. Safari вернёт тебя в `admin.html` с уже заполненными данными и ссылками фотографий.
7. Нажми «Скопировать фотографии и добавить товар».

## 5. Как клиент видит товар

Публичная витрина запрашивает `GET /api/products`. Карточка содержит название, описание, цену, площадку, ссылку на исходное объявление и изображения вида:

```text
https://your-worker.workers.dev/media/products/<product-id>/01.webp
```

Это не случайные фото и не скриншот страницы защиты — Worker сохраняет изображения, указанные непосредственно в открытом объявлении.

## Заказы и трекинг

- Заявки сохраняются через `POST /api/orders` и одновременно готовятся для отправки администратору в Telegram.
- Трек-код проверяется через `GET /api/tracking/<code>`.
- Менеджер обновляет трек через `PUT /api/tracking/<code>` с admin token.

## Проверка проекта

```bash
npm test
npm run check
```

## Важное ограничение

Автоматически развернуть Worker в чужом Cloudflare-аккаунте без авторизации невозможно. Весь код, конфигурация, импортёр и тесты готовы; остаётся один раз выполнить команды входа и deploy под аккаунтом владельца.
