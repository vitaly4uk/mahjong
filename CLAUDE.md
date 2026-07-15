# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Що це

Браузерна гра «маджонг-пасьянс»: поле 9×9×3 (мінус центр верхнього шару, 242 кістки), розклад **гарантовано розв'язний**. Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- Проєкт Django: `config/` (settings/urls/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями, **без npm/білда**. Phaser — локальний файл `static/vendor/phaser.min.js`.

## Структура гри

- `static/game/board.js` — модель поля: правило вільності (ніхто зверху + вільний лівий/правий бік), матчинг пар, undo-стек, детекція глухого кута. Чистий модуль, без Phaser/DOM.
- `static/game/generator.js` — генерація розкладу симуляцією зворотної гри (з повної форми знімаються випадкові вільні пари; записаний порядок = розв'язок). Чистий модуль.
- `static/game/stats.js` — довічна статистика (зіграно/перемоги/серії/рекорд часу/тотали підказок-скасувань-пар): чисті трансформери `applyWin`/`applyLoss` + `load`/`save` у `localStorage` (ключ `mahjong.stats.v1`). Чистий модуль, без Phaser/DOM.
- `static/game/main.js` — Phaser-сцена: рендер, кліки, кнопки (нова гра / підказка / undo / статистика), статуси. Довічні й поточні (за партію) числа статистики живуть у `this.registry`, DOM (мітки кнопок, зведення в тулбарі, модалка) перемальовується на подію `registry.events.on('changedata', ...)`. `window.mahjongGame` — доступ до гри для дебагу/тестів.
- `templates/game.html` — сторінка гри (корінь `/`), DOM-тулбар над канвасом і модалка `#stats-modal` зі статистикою.
- `static/game/tiles/*.png` — 35 CC0-тайлів з [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) (Export/Regular). Імена видів у коді = імена PNG.

### Нюанси рендеру (не ламати)

- **Depth**: `z*10000 + y*100 + (8-x)` — вищі шари, нижчі ряди та лівіші колонки малюються поверх (боковинка стирчить униз-вліво). Без цього кістки перекриваються хаотично.
- **Псевдо-3D**: шари зсуваються вгору-вправо (`LAYER_DX/DY`), кремова боковинка — згенерована текстура `tileSide`; нижні шари затемнюються `LAYER_TINTS`; кришка (`FACE_W/H`) менша за крок сітки — зазор відділяє сусідні кістки.
- **`#game-container` має фіксовану висоту** (`calc(100vh - 56px)`): якщо зробити її залежною від вмісту (flex: 1), Scale.FIT входить у петлю і канвас масштабується ривками.
- Тінт виділення скидається через `resetTileTint` (повертає шаровий тінт), не `clearTint`.

## Локальна розробка

```
uv sync                      # встановити залежності з uv.lock
uv run manage.py migrate
uv run manage.py runserver
```

Додавання залежностей: `uv add <package>` (прод) / `uv add --dev <package>` (dev-інструменти, лінтери, тести).

## Тести

Логіка гри тестується без браузера і без npm — вбудованим test runner Node:

```
node --test 'tests/*.test.js'
```

(Форма `node --test tests/` не працює — node трактує каталог як модуль.) Покрито: правило вільності, матчинг/undo, глухий кут, розв'язність генерації на 30 сідів, трансформери й localStorage-обгортку статистики (`stats.js`). `main.js` (Phaser) юніт-тестами не покривається — перевіряти в браузері.

## Конфігурація через env

`config/settings.py` читає:
- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG` (`True`/`False`, дефолт `True`)
- `DJANGO_ALLOWED_HOSTS` (через кому, наприклад `mahjong.vitaly4uk.in.ua`)

Локально можна не задавати — є дефолти для розробки (DEBUG=True, insecure SECRET_KEY).

## Деплой на dokku

Є `Dockerfile` (dokku автоматично деплоїть по ньому, без окремого buildpack). Перед першим пушем варто виставити env-змінні на сервері:

```
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku config:set mahjong DJANGO_DEBUG=False DJANGO_ALLOWED_HOSTS=mahjong.vitaly4uk.in.ua DJANGO_SECRET_KEY=<сгенерувати>'"
```

Далі — стандартний `git push dokku main` (див. розділ нижче).

## Інфраструктура

- **Proxmox host**: SSH-хост `proxmox` (див. `~/.ssh/config`), `HostName 192.168.88.2`, ключ `~/.ssh/pve_key`.
- **LXC 101**: контейнер `vitaly4uk.in.ua`, локальна адреса `192.168.88.169`. Керується з proxmox через `sudo pct exec 101 -- <cmd>`.
- **Dokku**: версія 0.38.23, встановлена всередині LXC 101.
- **Global vhost**: `dokku domains:set-global vitaly4uk.in.ua` вже виставлено — кожен новий `dokku apps:create <name>` автоматично отримує nginx-vhost `<name>.vitaly4uk.in.ua` на порту 80, без ручних дій.
- **Застосунок**: `mahjong`, створений через `dokku apps:create mahjong`.
  Публічний домен: `mahjong.vitaly4uk.in.ua`.
- **Зовнішній доступ**: через Cloudflare Tunnel (token-based, керується у Zero Trust дашборді на самому проєкті `vitaly4uk.in.ua`). Правило — wildcard `*.vitaly4uk.in.ua → http://localhost:80`, тобто трафік з Cloudflare йде на dokku nginx (порт 80), а той сам маршрутизує за Host-заголовком до потрібного застосунку. Новий субдомен `<name>.vitaly4uk.in.ua` працює одразу, без правок у Cloudflare.

### Порти в dokku (важливо для Dockerfile)

Dockerfile **не містить** `EXPOSE`. Це свідомо: dokku для Dockerfile-деплоїв
- **з `EXPOSE <port>`** → nginx слухає саме на цьому порту (і тоді треба або міняти Cloudflare-правило під нього, або робити `dokku ports:set`);
- **без `EXPOSE`** → nginx автоматично слухає на 80/443 і проксить на порт контейнера, заданий у env `$PORT` (dokku інжектить його сам, зазвичай 5000).

Тому gunicorn слухає `$PORT` (без дефолту — dokku завжди інжектить цю змінну для web-процесу). Команда запуску задається в `Procfile` (`web: gunicorn ... --bind 0.0.0.0:$PORT`), а не в `CMD` з `Dockerfile`: dokku для Dockerfile-деплоїв з наявним `Procfile` бере команду web-процесу саме звідти. **Важливо:** не використовуй у `Procfile` синтаксис `${PORT:-8000}` — dokku парсить рядки `Procfile` сам (не через shell рантайму контейнера) і не розуміє bash-fallback `:-`, через що змінна мовчки перетворюється на порожній рядок і gunicorn падає з `'' is not a valid port number`. Такий шаблон варто повторювати в майбутніх Dockerfile-застосунках — тоді кожен новий `<name>.vitaly4uk.in.ua` запрацює одразу через існуючий wildcard-тунель, без ручного налаштування портів.

## Доступ

- Прямий SSH до контейнера як звичайний користувач (`vitaly4uk@192.168.88.169`) **не працює** (немає доступу) — керування контейнером лише через `proxmox` host + `pct exec 101`.
- Git/dokku-доступ працює напряму з локальної машини по SSH:
  ```
  ssh dokku@192.168.88.169 apps:list
  ```
  Авторизація — публічний ключ `~/.ssh/id_ed25519.pub`, доданий через `dokku ssh-keys:add admin`.
- `192.168.88.169` — адреса в локальній мережі (LAN), доступна тільки коли dev-машина в тій самій мережі, що proxmox. Ззовні мережі деплой напряму не працюватиме, доки немає проброшеного порту 22 на `vitaly4uk.in.ua`.

## Git remote

У корені проєкту вже налаштовано:
```
dokku	dokku@192.168.88.169:mahjong (fetch)
dokku	dokku@192.168.88.169:mahjong (push)
```

## Деплой

```
git add .
git commit -m "..."
git push dokku main
```

Dokku деплоїть по `Dockerfile` з кореня репо (команда web-процесу — з `Procfile`). У Dockerfile вже є `collectstatic` (whitenoise), тож статика гри збирається під час білда.

## Корисні команди адміністрування (через proxmox)

```
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku apps:list'"
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku logs mahjong -t'"
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku config:show mahjong'"
```
