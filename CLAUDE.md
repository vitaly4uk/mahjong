# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Що це

Браузерна гра «маджонг-пасьянс»: поле — класична розкладка «Turtle» 12×8×3, обрізана до 136 кісток (автентична riichi-колода: 34 види × 4 копії), розклад **гарантовано розв'язний**. Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- **django-ninja** — увесь JSON/HTTP API проєкту (жодного plain Django view/`JsonResponse` — лише `admin/` (стандартна Django-адмінка) і `''` (рендер HTML-сторінки гри) лишаються поза ninja, бо це не API).
- Проєкт Django: `config/` (settings/urls/api/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями, **без npm/білда**. Phaser — локальний файл `static/vendor/phaser.min.js`.

## Структура гри

### Backend API (django-ninja)

- `config/api.py` — **єдиний проєктний `NinjaAPI`** (змонтований у `config/urls.py` як `path('api/', api.urls)`): хостить `GET /api/background/` (фонове фото з Pexels через кешований пул, `{"url": null}` якщо `PEXELS_API_KEY` не заданий), `GET /api/version/` (поточна версія білда, див. нижче) і підключає `gameplay.api.router` під `/game` (`api.add_router('/game', gameplay_router)` → `POST /api/game/start`, `POST /api/game/finish`). Тут же живе `CsrfOnly(APIKeyCookie)` — auth-заглушка, яка нікого не автентифікує (пускає й анонімів), але примусово ганяє звичайну Django CSRF-перевірку на кожен unsafe-запит (GET CSRF не чіпає); задана як `NinjaAPI(auth=CsrfOnly())`, тож успадковується всіма підключеними роутерами, якщо ті не перевизначають `auth=` самі.
  - `get_build_version()` — хеш маніфесту `collectstatic` (`staticfiles_storage.manifest_hash`, той самий `staticfiles.json`, який перегенеровує `GameStaticFilesStorage` з `config/storage.py` на кожен деплой) — дешевий, завжди актуальний індикатор "стався новий деплой", без окремого build-кроку чи версійного файлу. Порожній рядок локально, якщо `collectstatic` ще не запускали.
  - Те саме значення `config/urls.py` кладе в контекст кореневого шаблону (`window.MAHJONG_VERSION`) — клієнт звіряє його з `/api/version/` перед стартом нової партії (`static/game/main.js: startGame()`) і перезавантажує сторінку при розбіжності. Це фікс stale-кешу для встановленого standalone-застосунку на iOS/macOS (Add to Home Screen/Dock): таке вікно може висіти відкритим тижнями без жодної навігації, тому HTML/JS у пам'яті сам по собі ніколи не ревалідується — потрібна активна клієнтська перевірка. Свідомо без service worker (зайва складність і власний ризик stale SW-файлу для проєкту без офлайн-кешування).
- `config/schemas.py` — ninja `Schema` для `config/api.py` (`BackgroundResponse`, `VersionResponse`).
- `gameplay/` — Django-застосунок серверної генерації поля, антирід-валідації партії й довічної статистики гравця: `board.py` — Python-порт `static/game/board.js` (правило вільності, матчинг пар, зняття); `generator.py` — Python-порт `static/game/generator.js` (генерація розв'язного поля за складністю, без вимоги бітового паритету PRNG з JS — сервер єдине джерело поля); `models.py: GameSession` — модель токен-сесії, `user` nullable лише заради безболісної міграції вже існуючих рядків (новий код завжди проставляє); `models.py: Profile` — ігрові поля поверх стандартного `django.contrib.auth.User` (один на анонімного гравця, у майбутньому — і на Google-акаунт через django-allauth), несе `stats` (JSON-блоб `AllStats`) і `legacy_imported`; `middleware.py: PlayerIdentityMiddleware` — резолвить/створює `User`+`Profile` для будь-якого запиту під `/api/game/` і кладе як `request.profile` (той самий конвеншн, що вбудований `request.user`), ідентичність — підписана HttpOnly-кука `mahjong_player` (2 роки, `django.core.signing`, не `User.pk`, щоб не світити послідовний ID); `stats.py` — Python-порт `static/game/stats.js` (`apply_win`/`apply_loss`/`bump_started`/`bump_counter`/`merge_imported`) — сервер єдине джерело істини для довічних лічильників, клієнт більше нічого сам не рахує; `schemas.py` — ninja `Schema` (`StartRequest`/`StartResponse`/`FinishRequest`/`FinishResponse`/`BumpRequest`/`BumpResponse`/`StatsResponse`/`ImportRequest`/`ImportResponse`, `AllStats`/`LevelStats` з camelCase-аліасами); `api.py` — django-ninja `Router(by_alias=True)` (не самостійний `NinjaAPI` — монтується в `config/api.py`, camelCase-серіалізація полів статистики для клієнта): `POST /start` генерує розкладку й інкрементує `gamesStarted`, `POST /finish` реплеїть лог ходів і валідує результат (нелегальний хід/фейкова перемога/повторний claim — усе відхиляється), час партії рахує сервер (`now − created_at`), одноразовий claim — атомарний `UPDATE ... WHERE status='active'`, і лише після нього оновлює `gamesPlayed`/`gamesWon`/стрік/рекорд часу; `POST /{token}/bump` — живий інкремент hint/undo/pair-лічильника під час активної партії (не чекає фінішу); `GET /stats` — читає поточний блоб, бутстрапить профіль анонімові, якщо ще нема; `POST /stats/import` — одноразовий адитивний перенос старого localStorage-блоба (`gameplay/stats.py: merge_imported`), гард від повтору — `Profile.legacy_imported` на сервері. Статистику атрибутує `session.user.profile` (гравець, що СТАРТУВАВ партію), не обов'язково той, хто робить поточний запит — `_session_profile()` фолбечить на `request.profile` лише для перехідних сесій без прив'язаного `user`. Rate-limit на IP через `CF-Connecting-IP` (продакшен за Cloudflare Tunnel — `REMOTE_ADDR` бачив би саму адресу проксі). Див. `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`.
- `static/game/board.js` — модель поля для клієнтського інтерактиву: рендер кісток, кліки, undo-стек, детекція глухого кута; авторитетна перевірка (правило вільності, матчинг) — на сервері (`gameplay/board.py`). Також тут — `KINDS` (34 автентичні riichi-види; той самий список — з окремим `FRAMES` у `scripts/gen_tile_atlas.py` — задає ключі фреймів текстурного атласу). Чистий модуль, без Phaser/DOM.
- `static/game/stats.js` — довічні показники **по рівнях складності** (easy/normal/hard) тепер живуть на сервері (`gameplay/models.py: Profile.stats`); цей модуль лишає лише презентаційні хелпери (`winRate`/`fmtTime`), порожню форму-плейсхолдер (`emptyStats`/`emptyAllStats`, до першого мережевого запиту) і `load()` — використовується ЛИШЕ як одноразовий зчитувач legacy-блоба зі старого `localStorage` (ключ `mahjong.stats.v2`, старіший єдиний `mahjong.stats.v1` мігрується в рівень `hard`) для переносу на сервер (`main.js: create()` → `POST /api/game/stats/import`). `applyWin`/`applyLoss`/`save` видалені — клієнт більше нічого не пише в `localStorage`, підрахунок живе тільки на сервері (`gameplay/stats.py`). Чистий модуль, без Phaser/DOM.
- `static/game/sync.js` — тонкий HTTP-клієнт до `config/api.py`/`gameplay/api.py`: `startGame(level)`, `finishGame(token, moves, outcome)`, `bumpStat(token, counter)` (живий інкремент hint/undo/pair під час партії), `fetchStats()` (поточна довічна статистика профілю + `legacyImportAvailable`), `importLegacyStats(stats)` (одноразовий перенос старого `localStorage`-блоба), `fetchVersion()` (звіряння версії білда, див. `config/api.py`). Ідентичність гравця — кука `mahjong_player` (HttpOnly, підписана сервером — `gameplay/middleware.py`), їде автоматично з кожним fetch (`credentials: 'same-origin'`). CSRF-токен — з `window.MAHJONG_CSRF` (інжектиться в `templates/game.html` через `{{ csrf_token }}`), заголовок `X-CSRFToken`.
- `static/game/main.js` — Phaser-сцена: рендер кісток-паралелепіпедів, кліки, тулбар і смуга статусу (canvas-об'єкти, не DOM — див. нижче), модалка вибору складності при старті/новій грі, статуси. Поле для нової партії тягнеться з сервера через `sync.js` (без мережі гра не починається — жодної локальної генерації); клієнт веде лог знятих пар (`movesLog`, індекси кісток з серверного `layout`) і шле його на `finish`. Довічна статистика — з `fetchStats()` при запуску сторінки (не з `localStorage`); якщо сервер повернув `legacyImportAvailable`, старий `localStorage`-блоб (`stats.js: load()`) переноситься один раз через `importLegacyStats()`, після чого `clearLegacy()` прибирає локальні дані. `startGame()` першим ділом звіряє `fetchVersion()` з `window.MAHJONG_VERSION` і робить `location.reload()` замість старту партії при розбіжності (застарілий standalone-клієнт) — перевірка навмисно лише тут (не серед гри, щоб не перервати активну партію), помилка мережі перевірку не блокує. Фон (`loadBackground()`) вантажиться **двічі**: один раз при запуску сторінки (`create()`) і на кожну підтверджену перемогу (`finishGame()`) — нова гра/поразка фон не міняють; перехід між фото — кросфейд (900мс, `Sine.easeInOut`, стара текстура прибирається лише після завершення).
  Стан UI — Publisher/Subscriber через `this.registry` (Phaser `DataManager`, не сирий `CustomEvent`): бізнес-логіка ніде не викликає методів, що інтерпретують поведінку («відкрий модалку», «закрий») — лише пише факт (`registry.set(...)`), і єдиний підписник вирішує, що показати.
  - **Модалки**: `registry.get('modal')` — `null | {type:'newgame', canClose} | {type:'stats'} | {type:'result', won, error}`; підписник `renderModal()` (на `changedata-modal`) — єдине місце, що чіпає DOM модалок і вирішує текст заголовків. Ніяких `openStatsModal`/`closeAllModals`/`openNewGameModal` — усі виклик-сайти пишуть `registry.set('modal', ...)` напряму.
  - **Статус партії**: `registry.get('status')` (рядок) — пишуть `updateStatus()`, `startGame()`, `finishGame()`; читає й малює `renderStats()` (на широкий `changedata`, разом з довічними/поточними числами й підписами кнопок тулбару).
  `window.mahjongGame` — доступ до гри для дебагу/тестів.
- `templates/game.html` — сторінка гри (корінь `/`), лише `#game-container` (канвас) + дві модалки: вибору складності `#newgame-modal` (без кнопки закриття при першому запуску) і статистики `#stats-modal` (розбивка по рівнях). Тулбар і смуга статусу — **не DOM**, рендеряться всередині канваса (`main.js: createToolbar/createStatusBar`). Інжектить `window.MAHJONG_CSRF` і `window.MAHJONG_VERSION` (обидва — з контексту кореневого `TemplateView` в `config/urls.py`). Сам маршрут `/` (`config/urls.py: home_view`) обгорнутий `cache_control(no_cache=True, must_revalidate=True)` — HTML завжди ревалідується, коли навігація/перезавантаження таки стається (доповнює перевірку версії з `main.js`).
- `static/game/tiles/*.png` — 35 CC0-тайлів з [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) (Export/Regular), кожен 600×800. Імена видів у коді = імена PNG. Фронт їх напряму **не** запитує (їх замінює атлас нижче) — файли лишаються в репо як джерело для `scripts/gen_tile_atlas.py` і `scripts/gen_icons.py`.
- `static/game/tiles.webp` + `static/game/tiles.json` — текстурний атлас усіх 35 тайлів (Phaser JSON Hash), яким гра реально вантажить кістки: `this.load.atlas('tiles', ...)` у `preload()` (`static/game/main.js`), один WebP-запит замість 35 PNG. Генерується скриптом `scripts/gen_tile_atlas.py` з `static/game/tiles/*.png`: downscale кожного тайла до `TARGET_H` (320px по довшій стороні — з запасом покриває `FACE_H × devicePixelRatio` навіть на ретині/4K, див. коментар у скрипті) + пакування в сітку + lossless WebP (менший і чіткіший за lossy на цій пласкій лінійній графіці). Обидва артефакти комітяться в репо; перегенерувати: `uv run --with pillow python scripts/gen_tile_atlas.py` (Pillow ефемерний, той самий патерн, що й у `gen_icons.py`).
- `static/icons/*` — favicon + PWA/Apple-іконки (метод «крупного плану»: кремовий `Front.png` + червоний `Chun.png` по центру на діагональному градієнті зелений→смарагдовий), підключені в `templates/game.html` (`<link rel="icon"/apple-touch-icon>`) і `static/manifest.webmanifest` (`icons`). Генеруються скриптом `scripts/gen_icons.py` з тайлів у `static/game/tiles/` — Pillow тягнеться ефемерно, у проєктні залежності не додається: `uv run --with pillow python scripts/gen_icons.py`.

### Нюанси рендеру (не ламати)

- **Depth**: `z*10000 + y*100 + (WIDTH-1-x)` — вищі шари, нижчі ряди та лівіші колонки малюються поверх (боковинка стирчить униз-вліво, до глядача). Без цього кістки перекриваються хаотично.
- **Псевдо-3D шарів**: самі шари (z) зсуваються вгору-вправо (`LAYER_DX/DY`) — це окремий ефект від об'єму самої кістки (нижче).
- **Кістка — справжній 3D-паралелепіпед, не плоска картинка**: одна текстура `tileBody` (запечена в `create()` через `Graphics`+`generateTexture`, перевикористовується всіма 136 кістками) містить верхню грань-заглушку (під неї лягає `Front`) + дві скошені бокові стінки (`SIDE_COLOR` зліва, темніша `SIDE_SHADOW` знизу — світлотінь для об'єму), товщина — `DEPTH_X`/`DEPTH_Y`. Контейнер кістки — `[body, front, face]`; `body` зсунутий на `(-DEPTH_X/2, DEPTH_Y/2)`, щоб його верхня грань точно збіглася з `Front`.
  - Кути корпусу заокруглені (`CORNER_R`), щоб узгоджуватись із заокругленими кутами самого `Front.png` (інакше з-під округлення `Front` стирчить гострий кут корпусу). Техніка: дві точки-дотики (фаска) + `fillCircle` того ж радіуса поверх для заливки, і **окремо** семплована дуга (`arcPoints`, `Phaser.Math.DegToRad`) для контуру (`strokePoints`) — контур мусить огинати ту саму дугу, що й заливка, інакше лишається видимий шов між ними.
  - Геометрія — шестикутник із заокругленими кутами (`faceTL→faceTR→faceBR→baseBR→baseBL→baseTL`), а не два прямокутники: `faceBL` — внутрішня точка (захована під `Front`), тому в лівій і нижній стінках вона задана з протилежним напрямком обходу відносно контуру — переплутати напрямок легко і воно ламає заливку (стінки зникають), тому кожен `.reverse()` навмисний і закоментований.
- **`FACE_W`/`FACE_H` рахуються від `TILE_W`/`TILE_H` напряму (`GAP`), без відрахування `DEPTH_X`/`DEPTH_Y`.** Це навмисно: корпус (боковина) все одно ширший за лице на `DEPTH_X`/`DEPTH_Y`, тож рахувати `FACE_W` від `DEPTH_X` означало б, що зміна перекриття боковин ніяк не впливає на видиму щілину між лицями (боковина завжди "дотягувалась" кремовим кольором до сусіда, маскуючи різницю). Поточна формула розділяє два незалежних параметри: `GAP` — гарантований проміжок між лицями (ніколи не торкаються), `DEPTH_X − GAP` — наскільки боковини сусідніх кісток перекривають одна одну (компактний вигляд стеку).
- Тінт кістки (виділення/шар) — через `Phaser.Actions.SetTint(container.list, color)` на всі три дочірні елементи одразу; `resetTileTint` повертає шаровий тінт `LAYER_TINTS[z]`, не `clearTint`.
- Клік по кістці — **один сценовий обробник** `this.input.on('gameobjectdown', ...)` у `create()`, що читає плитку через `obj.getData('tile')` (не окремий `pointerdown`-замикання на кожен спрайт) — так само коректно ловить і кістки, додані пізніше через `undo()`. Той самий обробник (і окремо — власний `pointerdown` кожної кнопки тулбару в `createToolbar()`) починається з `if (this.registry.get('modal')) return;` — див. нижче, чому це не проста перестраховка.
- **DOM-модалка НЕ блокує клік по канвасу під собою.** Phaser слухає mouse/pointer на рівні `window`/`document` і сам робить hit-test по координатах — повністю в обхід реального DOM z-index/stacking; відкрита `position:fixed` модалка з `z-index:10` візуально накриває канвас, але клік по кістці чи кнопці тулбару під нею все одно долітає до Phaser (перевірено: `dispatchEvent` прямо на `document.body` у координатах під модалкою теж спрацьовує). Тому єдиний надійний захист — явний guard `if (this.registry.get('modal')) return;` у сценовому `gameobjectdown` і в `pointerdown` кожної кнопки тулбару (обидва місця, не одне — це різні обробники).
- **`#game-container` має фіксовану висоту** (`calc(100vh - var(--safe-top))`): якщо зробити її залежною від вмісту (flex: 1), Scale.FIT входить у петлю і канвас масштабується ривками.

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

Серверна логіка (`gameplay/`: генерація поля, правило вільності, валідація партії через API; `config/`: background-ендпоінт):

```
uv run manage.py test
```

(без аргументу — Django-discovery знаходить `gameplay/tests.py` і `config/tests.py` автоматично; `uv run manage.py test gameplay` звузить до одного застосунку.)

## Конфігурація через env

`config/settings.py` читає:
- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG` (`True`/`False`, дефолт `True`)
- `DJANGO_ALLOWED_HOSTS` (через кому, наприклад `mahjong.vitaly4uk.in.ua`)

Локально можна не задавати — є дефолти для розробки (DEBUG=True, insecure SECRET_KEY).

### CSRF за реверс-проксі (не ламати)

Продакшен ходить Cloudflare Tunnel → dokku nginx (термінує TLS тут) → gunicorn звичайним HTTP. `config/settings.py` виставляє:

```python
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
CSRF_TRUSTED_ORIGINS = [f'https://{h}' for h in ALLOWED_HOSTS]
```

Без цього Django вважає кожен запит незахищеним (`request.is_secure() == False`), а CSRF-перевірка Origin-заголовка (браузер шле `https://...`) не збігається з обчисленою схемою (`http://...`) → **403 на кожному POST**, незалежно від коректності самого CSRF-токена (django-ninja API це теж стосується — `CsrfOnly` у `config/api.py` покладається саме на цю перевірку). dokku nginx завжди проставляє `X-Forwarded-Proto`, тож довіряти йому безпечно.

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
