# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Що це

Браузерна гра «маджонг-пасьянс»: поле — класична розкладка «Turtle» 12×8×3, обрізана до 136 кісток (автентична riichi-колода: 34 види × 4 копії), розклад **гарантовано розв'язний**. Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- Проєкт Django: `config/` (settings/urls/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями, **без npm/білда**. Phaser — локальний файл `static/vendor/phaser.min.js`.

## Структура гри

- `gameplay/` — Django-застосунок серверної генерації поля й антирід-валідації партії: `board.py` — Python-порт `static/game/board.js` (правило вільності, матчинг пар, зняття); `generator.py` — Python-порт `static/game/generator.js` (генерація розв'язного поля за складністю); `models.py: GameSession` — модель токен-сесії без прив'язки до користувача; `api.py` — django-ninja API (`POST /api/game/start`, `POST /api/game/finish`): старт з генерацією розкладки, фініш із реплеєм логу ходів і валідацією результату, CSRF через `CsrfOnly(APIKeyCookie)` auth-клас (публічні анонімні ендпоїнти, але з обов'язковою CSRF-перевіркою). Див. `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`.
- `static/game/board.js` — модель поля для клієнтського інтерактиву: рендер кісток, кліки, undo-стек, детекція глухого кута; авторитетна перевірка (правило вільності, матчинг) — на сервері (`gameplay/board.py`). Чистий модуль, без Phaser/DOM.
- `static/game/stats.js` — довічна статистика **по рівнях складності** (easy/normal/hard, кожен зі своєю повною структурою: зіграно/перемоги/серії/рекорд часу/тотали підказок-скасувань-пар): чисті трансформери `applyWin`/`applyLoss` + `load`/`save` у `localStorage` (ключ `mahjong.stats.v2`; старий єдиний `mahjong.stats.v1` мігрується в рівень `hard` при першому `load()`). Чистий модуль, без Phaser/DOM.
- `static/game/main.js` — Phaser-сцена: рендер кісток-паралелепіпедів, кліки, кнопки (нова гра / підказка / undo / статистика), модалка вибору складності при старті/новій грі, статуси. Старт і фініш партії йдуть через `static/game/sync.js` (HTTP POST до `gameplay/api.py`); без мережи гра не починається. Довічні (по рівню) й поточні (за партію) числа статистики живуть у `this.registry`, DOM (мітки кнопок, зведення в тулбарі, модалки) перемальовується на подію `registry.events.on('changedata', ...)`. `window.mahjongGame` — доступ до гри для дебагу/тестів.
- `templates/game.html` — сторінка гри (корінь `/`), DOM-тулбар над канвасом, модалка вибору складності `#newgame-modal` (без кнопки закриття при першому запуску) і модалка статистики `#stats-modal` (розбивка по рівнях).
- `static/game/tiles/*.png` — 35 CC0-тайлів з [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) (Export/Regular). Імена видів у коді = імена PNG.
- `static/icons/*` — favicon + PWA/Apple-іконки (метод «крупного плану»: кремовий `Front.png` + червоний `Chun.png` по центру на діагональному градієнті зелений→смарагдовий), підключені в `templates/game.html` (`<link rel="icon"/apple-touch-icon>`) і `static/manifest.webmanifest` (`icons`). Генеруються скриптом `scripts/gen_icons.py` з тайлів у `static/game/tiles/` — Pillow тягнеться ефемерно, у проєктні залежності не додається: `uv run --with pillow python scripts/gen_icons.py`.

### Нюанси рендеру (не ламати)

- **Depth**: `z*10000 + y*100 + (WIDTH-1-x)` — вищі шари, нижчі ряди та лівіші колонки малюються поверх (боковинка стирчить униз-вліво, до глядача). Без цього кістки перекриваються хаотично.
- **Псевдо-3D шарів**: самі шари (z) зсуваються вгору-вправо (`LAYER_DX/DY`) — це окремий ефект від об'єму самої кістки (нижче).
- **Кістка — справжній 3D-паралелепіпед, не плоска картинка**: одна текстура `tileBody` (запечена в `create()` через `Graphics`+`generateTexture`, перевикористовується всіма 136 кістками) містить верхню грань-заглушку (під неї лягає `Front`) + дві скошені бокові стінки (`SIDE_COLOR` зліва, темніша `SIDE_SHADOW` знизу — світлотінь для об'єму), товщина — `DEPTH_X`/`DEPTH_Y`. Контейнер кістки — `[body, front, face]`; `body` зсунутий на `(-DEPTH_X/2, DEPTH_Y/2)`, щоб його верхня грань точно збіглася з `Front`.
  - Кути корпусу заокруглені (`CORNER_R`), щоб узгоджуватись із заокругленими кутами самого `Front.png` (інакше з-під округлення `Front` стирчить гострий кут корпусу). Техніка: дві точки-дотики (фаска) + `fillCircle` того ж радіуса поверх для заливки, і **окремо** семплована дуга (`arcPoints`, `Phaser.Math.DegToRad`) для контуру (`strokePoints`) — контур мусить огинати ту саму дугу, що й заливка, інакше лишається видимий шов між ними.
  - Геометрія — шестикутник із заокругленими кутами (`faceTL→faceTR→faceBR→baseBR→baseBL→baseTL`), а не два прямокутники: `faceBL` — внутрішня точка (захована під `Front`), тому в лівій і нижній стінках вона задана з протилежним напрямком обходу відносно контуру — переплутати напрямок легко і воно ламає заливку (стінки зникають), тому кожен `.reverse()` навмисний і закоментований.
- **`FACE_W`/`FACE_H` рахуються від `TILE_W`/`TILE_H` напряму (`GAP`), без відрахування `DEPTH_X`/`DEPTH_Y`.** Це навмисно: корпус (боковина) все одно ширший за лице на `DEPTH_X`/`DEPTH_Y`, тож рахувати `FACE_W` від `DEPTH_X` означало б, що зміна перекриття боковин ніяк не впливає на видиму щілину між лицями (боковина завжди "дотягувалась" кремовим кольором до сусіда, маскуючи різницю). Поточна формула розділяє два незалежних параметри: `GAP` — гарантований проміжок між лицями (ніколи не торкаються), `DEPTH_X − GAP` — наскільки боковини сусідніх кісток перекривають одна одну (компактний вигляд стеку).
- Тінт кістки (виділення/шар) — через `Phaser.Actions.SetTint(container.list, color)` на всі три дочірні елементи одразу; `resetTileTint` повертає шаровий тінт `LAYER_TINTS[z]`, не `clearTint`.
- Клік по кістці — **один сценовий обробник** `this.input.on('gameobjectdown', ...)` у `create()`, що читає плитку через `obj.getData('tile')` (не окремий `pointerdown`-замикання на кожен спрайт) — так само коректно ловить і кістки, додані пізніше через `undo()`.
- **`#game-container` має фіксовану висоту** (`calc(100vh - 56px)`): якщо зробити її залежною від вмісту (flex: 1), Scale.FIT входить у петлю і канвас масштабується ривками.

## Локальна розробка

```
uv sync                      # встановити залежності з uv.lock
uv run manage.py migrate
uv run manage.py runserver
```

Додавання залежностей: `uv add <package>` (прод) / `uv add --dev <package>` (dev-інструменти, лінтери, тести).

## Тести

Клієнтська логіка гри тестується без браузера й без npm — вбудованим test runner Node:

```
node --test 'tests/*.test.js'
```

(Форма `node --test tests/` не працює — node трактує каталог як модуль.) Покрито: правило вільності, матчинг/undo, глухий кут, розв'язність генерації на 30 сідів, трансформери й localStorage-обгортку статистики (`stats.js`). `main.js` (Phaser) юніт-тестами не покривається — перевіряти в браузері.

Серверна логіка (`gameplay/`: генерація поля, правило вільності, валідація партії через django-ninja API):

```
uv run manage.py test gameplay
```

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
