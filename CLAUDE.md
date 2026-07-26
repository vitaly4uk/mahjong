# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Мова

**Усі коментарі в коді (`.py`/`.js`) — англійською**, без винятків. Це правило
не поширюється на цей файл (CLAUDE.md), на `docs/superpowers/`, на
user-facing рядки (тексти UI, повідомлення статусу гравцю тощо) чи на git-
коміти — лише на коментарі всередині файлів вихідного коду.

## Що це

Браузерна гра «маджонг-пасьянс»: поле — одна з кількох класичних розкладок (Turtle/Dragon/Cat) на **144 кістки** (повний маджонг-набір: 34 звичайні види × 4 копії + 8 бонусних квітів/сезонів × 1), розклад **гарантовано розв'язний**. Форма поля (яка розкладка) обирається гравцем у модалці нової гри, ідентична для 144-кісткового набору незалежно від обраної форми — див. `gameplay/layouts.py`. Координати — пів-тайлова сітка (як у справжньому kmahjongg): звичайна кістка стоїть на парних координатах, а пік/виступи "голова-хвіст" — на непарних, точно між сусідами, без наближень. Бонусні види матчаться **wildcard-групами** (будь-яка квітка ↔ квітка, будь-який сезон ↔ сезон). Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/` (найновіше — `2026-07-25-full-144-mahjong.md`), `docs/superpowers/plans/`.

## Стиль коду (Python)

Для структур даних завжди `ninja.Schema` (або pydantic `BaseModel`), ніколи `namedtuple`/`@dataclass` — єдиний стиль моделей у проєкті (`gameplay/schemas.py`, `config/schemas.py`, `gameplay/layouts.py: Layout`).

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- **django-ninja** — увесь JSON/HTTP API проєкту (жодного plain Django view/`JsonResponse` — лише `admin/` (стандартна Django-адмінка) і `''` (рендер HTML-сторінки гри) лишаються поза ninja, бо це не API).
- Проєкт Django: `config/` (settings/urls/api/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями. Phaser — локальний файл `static/vendor/phaser.min.js`. **Збірка JS**: локальна розробка вантажить сирі ES-модулі `static/game/*.js` напряму (жодного локального білда — редагуй `.js`, онови сторінку); прод віддає **один мініфікований `bundle.js`**, який `esbuild` склеює з графа модулів на етапі Docker-білда (окремий `node`-стейдж `jsbuild` у `Dockerfile`). Перемикання — `{% if debug %}` у `templates/game.html`. `bundle.js` — build-артефакт, у git не комітиться (`.gitignore`). Кешбастинг — штатний `whitenoise.storage.CompressedManifestStaticFilesStorage` (хеш в імені файлу); whitenoise на `collectstatic` генерує `.gz` **і `.br`** для кожного статик-файла (brotli — залежність `brotli` у `pyproject.toml`; без неї був би лише gzip) і за `Accept-Encoding` віддає найменший варіант.

## Структура гри

### Backend API (django-ninja)

- `config/api.py` — **єдиний проєктний `NinjaAPI`** (змонтований у `config/urls.py` як `path('api/', api.urls)`): хостить `GET /api/background/` (фонове фото з Pexels через кешований пул, `{"url": null}` якщо `PEXELS_API_KEY` не заданий), `GET /api/version/` (поточна версія білда, див. нижче) і підключає `gameplay.api.router` під `/game` (`api.add_router('/game', gameplay_router)` → `POST /api/game/start`, `POST /api/game/finish`). Тут же живе `CsrfOnly(APIKeyCookie)` — auth-заглушка, яка нікого не автентифікує (пускає й анонімів), але примусово ганяє звичайну Django CSRF-перевірку на кожен unsafe-запит (GET CSRF не чіпає); задана як `NinjaAPI(auth=CsrfOnly())`, тож успадковується всіма підключеними роутерами, якщо ті не перевизначають `auth=` самі.
  - `get_build_version()` — хеш маніфесту `collectstatic` (`staticfiles_storage.manifest_hash`, той самий `staticfiles.json`, який перегенеровує штатний `whitenoise.storage.CompressedManifestStaticFilesStorage` на кожен деплой) — дешевий, завжди актуальний індикатор "стався новий деплой", без окремого build-кроку чи версійного файлу. Зміна вмісту `bundle.js` сама рухає хеш. Порожній рядок локально, якщо `collectstatic` ще не запускали.
  - Те саме значення `config/urls.py` кладе в контекст кореневого шаблону (`window.MAHJONG_VERSION`) — клієнт звіряє його з `/api/version/` перед стартом нової партії (`static/game/main.js: startGame()`) і перезавантажує сторінку при розбіжності. Це фікс stale-кешу для встановленого standalone-застосунку на iOS/macOS (Add to Home Screen/Dock): таке вікно може висіти відкритим тижнями без жодної навігації, тому HTML/JS у пам'яті сам по собі ніколи не ревалідується — потрібна активна клієнтська перевірка. Свідомо без service worker (зайва складність і власний ризик stale SW-файлу для проєкту без офлайн-кешування).
- `config/schemas.py` — ninja `Schema` для `config/api.py` (`BackgroundResponse`, `VersionResponse`).
- `layouts/*.layout` (корінь проєкту) — форми полів у **рідному форматі kmahjongg** (`kmahjongg-layout-v1.1`, ASCII-сітка: заголовок + `w`/`h`/`d` (розмір) + `d` блоків `h`×`w` символів, костяшка — блок 2×2 символів `1`(якір, верх-ліво)/`2`(верх-право)/`3`(низ-право)/`4`(низ-ліво), `.` — пусто). Три файли — `turtle.layout` (= KDE `default.layout`), `dragon.layout`, `cat.layout` — усі взяті дослівно з [KDE kmahjongg](https://invent.kde.org/games/kmahjongg) (GPL, атрибуція в `#`-коментарі кожного файла); ім'я розкладки для UI — теж перший `#`-коментар після заголовка (kmahjongg тримає ім'я в окремому `.desktop`-файлі — тут воно згорнуте в сам `.layout` для самодостатності). Приймаються **лише 144-кісткові** розкладки (парсер рахує символи-якорі `1` — колода проєкту жорстко 72 пари = 144, див. нижче); з ~70 розкладок апстріму це відсікає більшість (144 — не найпопулярніший розмір у kmahjongg).
- `gameplay/` — Django-застосунок серверної генерації поля, антирід-валідації партії й довічної статистики гравця: `layouts.py` — парсер `.layout`-файлів (`parse_layout`/`load_layouts`/`get_layout`/`list_boards`, `Layout(ninja.Schema)`): звіряє заголовок/розміри/144-кістки, нормалізує координати (kmahjongg паддить сітку порожніми колонками/рядками навколо фігури — парсер відкидає це підрізанням до bounding box), кешується на процес (`@lru_cache`, як `staticfiles.json` у whitenoise). `board.py` — Python-порт `static/game/board.js` (правило вільності, матчинг пар, зняття) — сам по собі **форму поля не знає**, лише координатну систему; `generator.py` — серверна генерація гарантовано розв'язного поля за складністю **і формою** (`generate_for_difficulty(level, layout, seed)`, `layout` — з `layouts.py`; єдине джерело поля, клієнтського `generator.js` немає): зворотна симуляція знімає вільні пари з повної форми. Колода — 34 звичайні види × 2 пари `(k, k)` + 4 квіти + 4 сезони як 2 різні-в-групі пари = **72 пари = 144 кістки** (`match_key` з `board.py` задає wildcard-групи), однакова для будь-якої форми; `models.py: GameSession` — модель токен-сесії, `user` nullable лише заради безболісної міграції вже існуючих рядків (новий код завжди проставляє); `models.py: Profile` — ігрові поля поверх стандартного `django.contrib.auth.User` (один на анонімного гравця, у майбутньому — і на Google-акаунт через django-allauth), несе `stats` (JSON-блоб `AllStats`) і `legacy_imported`; `middleware.py: PlayerIdentityMiddleware` — резолвить/створює `User`+`Profile` для будь-якого запиту під `/api/game/` і кладе як `request.profile` (той самий конвеншн, що вбудований `request.user`), ідентичність — підписана HttpOnly-кука `mahjong_player` (2 роки, `django.core.signing`, не `User.pk`, щоб не світити послідовний ID); `stats.py` — Python-порт `static/game/stats.js` (`apply_win`/`apply_loss`/`bump_started`/`bump_counter`/`merge_imported`) — сервер єдине джерело істини для довічних лічильників, клієнт більше нічого сам не рахує; `schemas.py` — ninja `Schema` (`StartRequest`/`StartResponse`/`FinishRequest`/`FinishResponse`/`BumpRequest`/`BumpResponse`/`StatsResponse`/`ImportRequest`/`ImportResponse`, `AllStats`/`LevelStats` з camelCase-аліасами; `StartRequest.board` — slug розкладки, дефолт `'turtle'`); `api.py` — django-ninja `Router(by_alias=True)` (не самостійний `NinjaAPI` — монтується в `config/api.py`, camelCase-серіалізація полів статистики для клієнта): `POST /start` приймає `level`+`board`, валідує `board` через `layouts.get_layout()` (400 на невідомий slug), генерує розкладку й інкрементує `gamesStarted`, `POST /finish` реплеїть лог ходів і валідує результат (нелегальний хід/фейкова перемога/повторний claim — усе відхиляється), час партії рахує сервер (`now − created_at`), одноразовий claim — атомарний `UPDATE ... WHERE status='active'`, і лише після нього оновлює `gamesPlayed`/`gamesWon`/стрік/рекорд часу; `POST /{token}/bump` — живий інкремент hint/undo/pair-лічильника під час активної партії (не чекає фінішу); `GET /{token}` — стан сесії для відновлення партії після перезавантаження сторінки (`active`/`claimed`/`expired`/`unknown`, для `active` — `elapsedMs`; протермінована `active`-сесія віддається як `expired` без запису в БД, ліниве маркування лишається за `finish`); `GET /stats` — читає поточний блоб, бутстрапить профіль анонімові, якщо ще нема; `POST /stats/import` — одноразовий адитивний перенос старого localStorage-блоба (`gameplay/stats.py: merge_imported`), гард від повтору — `Profile.legacy_imported` на сервері. Статистику атрибутує `session.user.profile` (гравець, що СТАРТУВАВ партію), не обов'язково той, хто робить поточний запит — `_session_profile()` фолбечить на `request.profile` лише для перехідних сесій без прив'язаного `user`. Rate-limit на IP через `CF-Connecting-IP` (продакшен за Cloudflare Tunnel — `REMOTE_ADDR` бачив би саму адресу проксі). Див. `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`.
- `static/game/board.js` — модель поля для клієнтського інтерактиву: рендер кісток, кліки, undo-стек, детекція глухого кута; авторитетна перевірка (правило вільності, матчинг) — на сервері (`gameplay/board.py`). Форма поля (яка розкладка) тут **не** зашита — `board.js` знає лише координатну систему (пів-тайлова сітка), самі позиції приходять із серверного `layout`; ширину/висоту/кількість шарів поля клієнт виводить із цього масиву (`main.js: applyBoardDims`), а не з констант модуля. Також тут — `KINDS` (42 види: 34 автентичні riichi + 8 бонусних квітів/сезонів; імена = імена SVG-файлів у `static/game/tiles/`), `FLOWERS`/`SEASONS` і `matchKey(kind)` (усі квіти → `'flower'`, усі сезони → `'season'`, решта — сам вид; `canMatch`/`findMatchingPair` порівнюють `matchKey`, а не `kind` — wildcard-групи), і `replayMoves(tiles, moves)` — чиста функція відновлення партії з збереженого лога ходів (`main.js`: відновлення після перезавантаження сторінки): реплеїть `moves` через `Board.removePair`, повертає `Board` з природно відновленим undo-стеком або `null` на першому ж нелегальному ході (сигнал відкинути збереження). Чистий модуль, без Phaser/DOM.
- `static/game/stats.js` — довічні показники **по рівнях складності** (easy/normal/hard) тепер живуть на сервері (`gameplay/models.py: Profile.stats`); цей модуль лишає лише презентаційні хелпери (`winRate`/`fmtTime`), порожню форму-плейсхолдер (`emptyStats`/`emptyAllStats`, до першого мережевого запиту) і `load()` — використовується ЛИШЕ як одноразовий зчитувач legacy-блоба зі старого `localStorage` (ключ `mahjong.stats.v2`, старіший єдиний `mahjong.stats.v1` мігрується в рівень `hard`) для переносу на сервер (`main.js: create()` → `POST /api/game/stats/import`). `applyWin`/`applyLoss`/`save` видалені — клієнт більше нічого не пише в `localStorage`, підрахунок живе тільки на сервері (`gameplay/stats.py`). Чистий модуль, без Phaser/DOM.
- `static/game/sync.js` — тонкий HTTP-клієнт до `config/api.py`/`gameplay/api.py`: `startGame(level, board)` (`board` — slug з `layouts/*.layout`, дефолт `'turtle'` на сервері), `finishGame(token, moves, outcome)`, `bumpStat(token, counter)` (живий інкремент hint/undo/pair під час партії), `fetchStats()` (поточна довічна статистика профілю + `legacyImportAvailable`), `importLegacyStats(stats)` (одноразовий перенос старого `localStorage`-блоба), `fetchVersion()` (звіряння версії білда, див. `config/api.py`), `fetchSessionState(token)` (стан серверної сесії — `active`/`claimed`/`expired`/`unknown` + `elapsedMs` для `active` — для відновлення партії після перезавантаження сторінки). Ідентичність гравця — кука `mahjong_player` (HttpOnly, підписана сервером — `gameplay/middleware.py`), їде автоматично з кожним fetch (`credentials: 'same-origin'`). CSRF-токен — з `window.MAHJONG_CSRF` (інжектиться в `templates/game.html` через `{{ csrf_token }}`), заголовок `X-CSRFToken`.
- `static/game/main.js` — Phaser-сцена: рендер кісток-паралелепіпедів, кліки, тулбар і смуга статусу (canvas-об'єкти, не DOM — див. нижче), модалка вибору розкладки й складності при старті/новій грі, статуси. Поле для нової партії тягнеться з сервера через `sync.js` (без мережі гра не починається — жодної локальної генерації); клієнт веде лог знятих пар (`movesLog`, індекси кісток з серверного `layout`) і шле його на `finish`. **Форма поля** (ширина/висота/кількість шарів — `this.boardWidth/boardHeight/boardLayers`) виводиться з масиву `layout`, а не зашита константами (`applyBoardDims(layout)`: `max(x)+2`/`max(y)+2`/`max(z)+1`, викликається в `startGame()` і `tryResumeGame()` до створення спрайтів кісток; `computeLayout()` і `setDepth` у `addTileSprite` читають ці поля). До першої реальної партії (стартова модалка) канвас розміряється під дефолтні виміри Turtle (`DEFAULT_BOARD_DIMS`), щоб перший рендер не був порожнім. Вибір розкладки — кнопки `[data-board]` у `#newgame-modal` (рендеряться Django-шаблоном з контексту `boards`, `gameplay/layouts.py: list_boards()`), той самий патерн Publisher/Subscriber, що й вибір складності (`[data-level]`): клік по розкладці лише оновлює `this.currentBoard`+підсвітку (не стартує гру), клік по складності стартує гру з поточними `currentLevel`+`currentBoard`; вибір persist-иться в `localStorage` (`mahjong.board`, як і `mahjong.difficulty`), звіряється проти реально відрендерених кнопок (застарілий slug зі старого деплою — фолбек на `'turtle'`). Довічна статистика — з `fetchStats()` при запуску сторінки (не з `localStorage`); якщо сервер повернув `legacyImportAvailable`, старий `localStorage`-блоб (`stats.js: load()`) переноситься один раз через `importLegacyStats()`, після чого `clearLegacy()` прибирає локальні дані. `startGame()` першим ділом звіряє `fetchVersion()` з `window.MAHJONG_VERSION` і робить `location.reload()` замість старту партії при розбіжності (застарілий standalone-клієнт) — перевірка навмисно лише тут (не серед гри, щоб не перервати активну партію), помилка мережі перевірку не блокує. **Відновлення партії після перезавантаження сторінки**: `persistGame()` пише знімок `{token, level, board, layout, movesLog, hints, undos}` у `localStorage` (ключ `mahjong.activeGame.v1`, окрема лінія версій від `mahjong.stats.v1/v2` — тих легасі-блобів статистики) на кожен `startGame()`/`bumpCounter()` (тобто на кожну зміну `movesLog` чи hint/undo-лічильника — `bumpCounter()` єдина точка виклику, бо `removePair`/`undo`/`hint` завжди йдуть через неї). `create()` викликає `tryResumeGame()` замість стартової модалки, якщо є збережений знімок: звіряє токен через `fetchSessionState`, і лише для `active`-сесії реплеїть `movesLog` (`board.js: replayMoves`) — будь-яка невідповідність (мережа, сесія вже не `active`, битий/підроблений лог) тихо відкидає збереження й показує звичайну стартову модалку (`saved.board` відсутній у знімках зі старих деплоїв до появи вибору розкладки — тоді фолбек на `'turtle'`, єдину розкладку, що тоді існувала). `finishGame()` чистить збережений знімок (`clearActiveGame()`) одразу після відповіді сервера (і `valid`, і `invalid` — сесія вже closed на сервері), мережева помилка збереження не чіпає (наступне завантаження спробує відновити знову). Фон (`loadBackground()`) вантажиться **двічі**: один раз при запуску сторінки (`create()`) і на кожну підтверджену перемогу (`finishGame()`) — нова гра/поразка фон не міняють; перехід між фото — кросфейд (900мс, `Sine.easeInOut`, стара текстура прибирається лише після завершення).
  Стан UI — Publisher/Subscriber через `this.registry` (Phaser `DataManager`, не сирий `CustomEvent`): бізнес-логіка ніде не викликає методів, що інтерпретують поведінку («відкрий модалку», «закрий») — лише пише факт (`registry.set(...)`), і єдиний підписник вирішує, що показати.
  - **Модалки**: `registry.get('modal')` — `null | {type:'newgame', canClose} | {type:'stats'} | {type:'result', won, error}`; підписник `renderModal()` (на `changedata-modal`) — єдине місце, що чіпає DOM модалок і вирішує текст заголовків. Ніяких `openStatsModal`/`closeAllModals`/`openNewGameModal` — усі виклик-сайти пишуть `registry.set('modal', ...)` напряму.
  - **Статус партії**: `registry.get('status')` (рядок) — пишуть `updateStatus()`, `startGame()`, `finishGame()`; читає й малює `renderStats()` (на широкий `changedata`, разом з довічними/поточними числами й підписами кнопок тулбару).
  `window.mahjongGame` — доступ до гри для дебагу/тестів.
- `templates/game.html` — сторінка гри (корінь `/`), лише `#game-container` (канвас) + дві модалки: вибору розкладки й складності `#newgame-modal` (без кнопки закриття при першому запуску) і статистики `#stats-modal` (розбивка по рівнях). Кнопки розкладки (`[data-board]`) рендеряться циклом `{% for board in boards %}` з контексту `TemplateView` (`config/urls.py: home_view` → `gameplay.layouts.list_boards()`) — самі дані `board.slug`/`board.name` в DOM, окремого `window.MAHJONG_BOARDS` немає (той самий патерн, що й статичні кнопки складності `[data-level]`: `main.js` читає атрибути прямо з DOM). Тулбар і смуга статусу — **не DOM**, рендеряться всередині канваса (`main.js: createToolbar/createStatusBar`). Інжектить `window.MAHJONG_CSRF` і `window.MAHJONG_VERSION` (обидва — з контексту кореневого `TemplateView` в `config/urls.py`). Сам маршрут `/` (`config/urls.py: home_view`) обгорнутий `cache_control(no_cache=True, must_revalidate=True)` — HTML завжди ревалідується, коли навігація/перезавантаження таки стається (доповнює перевірку версії з `main.js`).
- `static/game/tiles/*.svg` — **42 oblique-3D тайли** (набір Cangjie6 з Wikimedia, **CC BY-SA 4.0**, див. `static/game/tiles/CREDITS.md` — обов'язкова атрибуція + share-alike), кожен ~210×255 viewBox. Імена файлів = імена видів у коді (`Man1.svg`…`Chun.svg`, `Plum/Orchid/Bamboo/Chrysanthemum`, `Spring/Summer/Autumn/Winter`). Гра вантажить їх як blob-URL Image і растеризує у `CanvasTexture` у рантаймі (`main.js: loadTileImages`/`rasterizeTiles`) — жодного текстурного атласу (колишні `tiles.webp`/`tiles.json` і `scripts/gen_tile_atlas.py` прибрані). SVG почищено від Adobe-метаданих (`<!DOCTYPE>`/`<foreignObject>` отруювали WebGL-канвас).
- `static/game/tiles/*.png` + `Front.png` — старий CC0-набір [FluffyStuff](https://github.com/FluffyStuff/riichi-mahjong-tiles) (Export/Regular, 600×800). Гра ними більше **не** рендерить кістки — лишились лише як джерело для `scripts/gen_icons.py` (favicon/PWA-іконки з `Front.png`+`Chun.png`).
- `static/icons/*` — favicon + PWA/Apple-іконки (метод «крупного плану»: кремовий `Front.png` + червоний `Chun.png` по центру на діагональному градієнті зелений→смарагдовий), підключені в `templates/game.html` (`<link rel="icon"/apple-touch-icon>`) і `static/manifest.webmanifest` (`icons`). Генеруються скриптом `scripts/gen_icons.py` з тайлів у `static/game/tiles/` — Pillow тягнеться ефемерно, у проєктні залежності не додається: `uv run --with pillow python scripts/gen_icons.py`.

### Нюанси рендеру (не ламати)

- **Depth**: `z*10000 + (this.boardHeight-1-y) + x` (`boardHeight` — виводиться з поточного `layout`, не константа, див. `applyBoardDims` вище) — вищі шари, вищі ряди (менший y) та правіші колонки малюються поверх (боковинка Cangjie6 намальована зверху й праворуч від лиця — сусід з меншим y/більшим x має ховати її під собою). Вага x і y **однакова** (не `×100` для y) — інакше різниця по y «забиває» x і ламає порядок малювання саме для діагональних пів-тайлових сусідів (вершина піку, виступи голова/хвіст: відрізняються на ±1 в обох осях одночасно). Без цього кістки перекриваються хаотично або лишають видимою чужу боковину.
- **Псевдо-3D шарів**: самі шари (z) зсуваються вгору-вправо (`LAYER_DX/DY`) — це окремий ефект від об'єму самої кістки (нижче).
- **Кістка = один спрайт із готовим oblique-3D-артом** (набір Cangjie6, CC BY-SA; SVG у `static/game/tiles/`). Об'єм (боковинки/товщина) **намальований у самому спрайті** — гра більше НЕ пече власний 3D-корпус (колишні `tileBody`+`Front`+геометрія боковинок і константи `DEPTH_X/Y`, `CORNER_R`, `FACE_W/H`, `GAP`, `SIDE_*` прибрані). `addTileSprite` створює `this.add.image(x, y, kind)` з текстурою-видом. Псевдо-3D-стек (зсув шарів `LAYER_DX/DY` + depth вище) лишився — саме так стекаються oblique-тайли; напрям зсуву узгоджений з намальованою товщиною (нижчі ряди/лівіші колонки/вищі шари — поверх).
- **Текстури тайлів растеризуються з SVG у рантаймі** (`rasterizeTiles`): кожен вид малюється у `CanvasTexture` під фактичний піксельний розмір тайла (`LM.tileW/tileH`, вже device-px) → різко на будь-якому DPI. SVG вантажаться як **blob-URL Image** (`loadTileImages`), не `<img src>` — інакше намальований у канвас http-SVG «отруює» його (tainted), і WebGL відмовляється від текстури; той самий підхід, що й у Phaser SVGFile. Adobe-SVG попередньо почищено від `<!DOCTYPE>`/`<foreignObject>` (теж отруювали канвас) — див. `static/game/tiles/CREDITS.md`.
- **Нативне розрішення (`Scale.NONE` + ручний DPR-скейл), не `Scale.FIT`**: `resizeCanvas` виставляє backing = CSS-розмір × dpr, а CSS-розмір = контейнер, тож **world-координати в device-px** і все рендериться 1:1 (жодного CSS-розтягу-мила). Розкладка **динамічна**: `computeLayout` рахує розмір тайла й точку відліку (центрування) від поточного розміру канваса; `d(n)=n*dpr` переводить design-px у device-px. `handleResize` (дебаунс ~120мс) на кожну зміну вікна: перерахунок розкладки + перерастр тайлів (`rasterizeTiles`, з гардом «той самий розмір — пропустити») + перепозиція кісток і UI (`relayoutTiles`/`layoutUI`).
- Тінт кістки (виділення/шар) — `sprite.setTint(color)` на єдиний спрайт; `resetTileTint` повертає шаровий тінт `LAYER_TINTS[z]` (масив на 5 шарів, нижчі темніші), не `clearTint`.
- Клік по кістці — **один сценовий обробник** `this.input.on('gameobjectdown', ...)` у `create()`, що читає плитку через `obj.getData('tile')` (не окремий `pointerdown`-замикання на кожен спрайт) — так само коректно ловить і кістки, додані пізніше через `undo()`. Той самий обробник (і окремо — власний `pointerdown` кожної кнопки тулбару в `createToolbar()`) починається з `if (this.registry.get('modal')) return;` — див. нижче, чому це не проста перестраховка.
- **DOM-модалка НЕ блокує клік по канвасу під собою.** Phaser слухає mouse/pointer на рівні `window`/`document` і сам робить hit-test по координатах — повністю в обхід реального DOM z-index/stacking; відкрита `position:fixed` модалка з `z-index:10` візуально накриває канвас, але клік по кістці чи кнопці тулбару під нею все одно долітає до Phaser (перевірено: `dispatchEvent` прямо на `document.body` у координатах під модалкою теж спрацьовує). Тому єдиний надійний захист — явний guard `if (this.registry.get('modal')) return;` у сценовому `gameobjectdown` і в `pointerdown` кожної кнопки тулбару (обидва місця, не одне — це різні обробники).
- **`#game-container` має фіксований розмір** (`width:100%; max-width:800px; height: calc(100vh - var(--safe-top))`): `resizeCanvas` читає саме `clientWidth/clientHeight` контейнера — контент-залежна висота (flex:1) дала б зворотний зв'язок canvas↔container і ривки. Тому канвас заповнює контейнер, а не навпаки.

## Локальна розробка

```
uv sync                      # встановити залежності з uv.lock
uv run manage.py migrate
uv run manage.py runserver
```

Додавання залежностей: `uv add <package>` (прод) / `uv add --dev <package>` (dev-інструменти, лінтери, тести).

## Локалізація

Штатний Django gettext-i18n (`uk` + `en`), msgid — **англійською** (ідіоматичний Django),
переклади — `locale/{uk,en}/LC_MESSAGES/{django,djangojs}.po`. Дефолт для нового
відвідувача без куки й без збігу `Accept-Language` — українська (`LANGUAGE_CODE = 'uk'`,
`config/settings.py`). Перемикач мови — кнопка `🌐 UA`/`🌐 EN` у самому тулбарі
(`static/game/main.js: createToolbar()`, той самий канвасний ряд, що й «Нова гра»/
«Підказка»/«Скасувати»/«Статистика», п'ята кнопка), не в модалці. Лише дві мови
(`config/settings.py: LANGUAGES`), тож це простий тоггл (`OTHER_LANG`), а не пікер:
показує ПОТОЧНУ мову, клік перемикає на іншу. `window.MAHJONG_LANG` (з
`{% get_current_language %}`, `templates/game.html`) — джерело поточної мови для
JS. Клік шле POST у Django `set_language` (`static/game/sync.js: setLanguage()`,
`config/urls.py: path('i18n/', include('django.conf.urls.i18n'))`) і перезавантажує
сторінку — **без** `i18n_patterns`, URL кореня `/` лишається чистим (важливо для
standalone-PWA/`start_url`). Активна партія переживає перезавантаження без втрат
(`tryResumeGame()` — той самий шлях, що й для звичайного reload/resume).

Більшість тексту рендериться на Phaser-канвасі (`static/game/main.js`), тож основний
канал перекладу — Django **`JavaScriptCatalog`** (`config/urls.py:
path('jsi18n/', JavaScriptCatalog.as_view())`, без `packages=` — каталог живе в
проєктному `locale/`, не всередині `gameplay/locale/`), підключений у `game.html`
**класичним** `<script>` (не `type="module"`) **перед** модульним бандлом — глобальні
`gettext`/`interpolate` мають бути визначені до виконання `main.js`/`bundle.js`.
Емодзі-префікси (`🆕`, `💡`, `🏆`, ...) свідомо лишаються **поза** `gettext()`/
`{% trans %}` — вони мовонезалежні, перекладати нема чого.

Назви розкладок (`Turtle`/`Dragon`/`Cat`, з `#`-коментарів `.layout`-файлів) кешуються
процесом (`gameplay/layouts.py: load_layouts()`, `@lru_cache`) — тому переклад
застосовується не до самого кешованого імені, а щоразу в `list_boards()` через
`gettext(layout.name)`; відомі назви зареєстровані через `gettext_noop()` для
`makemessages`.

Каталоги перекомпілюються з `.po` в `.mo` на кожному Docker-білді
(`Dockerfile: RUN uv run manage.py compilemessages`, вимагає системний `gettext`) —
`.mo` у git не комітяться (`.gitignore: locale/**/*.mo`), як і `bundle.js`. Після зміни
перекладного тексту в коді — перегенерувати каталоги:

```
uv run manage.py makemessages -l uk -l en \
  --ignore='static/vendor/*' --ignore='static/game/bundle.js' \
  --ignore='staticfiles/*' --ignore='.venv/*'
uv run manage.py makemessages -d djangojs -l uk -l en \
  --ignore='static/vendor/*' --ignore='static/game/bundle.js' \
  --ignore='staticfiles/*' --ignore='.venv/*'
uv run manage.py compilemessages --locale=uk --locale=en   # для локальної перевірки
```

## Тести

Клієнтська логіка гри тестується без браузера й без npm — вбудованим test runner Node:

```
node --test 'tests/*.test.js'
```

(Форма `node --test tests/` не працює — node трактує каталог як модуль.) Покрито: правило вільності, матчинг/undo, глухий кут, replay лога ходів, трансформери й localStorage-обгортку статистики (`stats.js`). Форма поля (яка розкладка, розв'язність генерації) клієнтськими тестами більше не покривається — вона повністю на сервері (нижче), `board.js` тепер знає лише координатну систему, не конкретну фігуру. `main.js` (Phaser) юніт-тестами не покривається — перевіряти в браузері.

Серверна логіка (`gameplay/`: парсер `.layout`-файлів, генерація поля для кожної розкладки, правило вільності, валідація партії через API; `config/`: background-ендпоінт):

```
uv run manage.py test
```

(без аргументу — Django-discovery знаходить `gameplay/tests.py` і `config/tests.py` автоматично; `uv run manage.py test gameplay` звузить до одного застосунку.)

## Лінтинг (критерій виконання задачі)

Задача НЕ вважається завершеною, поки обидва лінтери не проходять чисто —
нарівні з тестами вище:

- **Python (`ruff`)** — dev-залежність (`uv add --dev ruff`, у прод-образ не
  тягнеться: Dockerfile робить `uv sync ... --no-dev`), конфіг —
  `[tool.ruff]`/`[tool.ruff.lint]` у `pyproject.toml` (`select = ["E", "F",
  "I", "UP", "B", "DJ"]`, `migrations`/`staticfiles` виключені):
  ```
  uv run ruff check .
  ```
  Автофікс безпечних (сортування імпортів, pyupgrade): `uv run ruff check --fix .`

- **JS (`Biome`)** — без локального `node_modules`, гониться через `npx` з
  піном версії (той самий підхід, що й `esbuild` у `Dockerfile: jsbuild`),
  конфіг — `biome.json` (лінтить лише `static/game/**/*.js` і `tests/**/*.js`,
  виключає build-артефакт `bundle.js`; `static/vendor/` не мапиться жодним
  include-патерном, тож теж поза скоупом):
  ```
  npx --yes @biomejs/biome@2.5.5 lint static/game tests
  ```
  Автофікс: `npx --yes @biomejs/biome@2.5.5 lint --write static/game tests`
  (частина фіксів `--unsafe` — перевіряти діфф перед застосуванням).

Обидва лінтери — суто статичний аналіз, окремого CI під них немає (немає
GitHub-remote, деплой — dokku), тож команди вище ганяються вручну перед
комітом/завершенням задачі.

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
