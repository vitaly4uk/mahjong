# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Мова

**Усі коментарі в коді (`.py`/`.js`) — англійською**, без винятків. Це правило
не поширюється на цей файл (CLAUDE.md), на `docs/superpowers/`, на
user-facing рядки (тексти UI, повідомлення статусу гравцю тощо) чи на git-
коміти — лише на коментарі всередині файлів вихідного коду.

## Документація

**Цей файл — карта, не дзеркало докстрінгів.** Тут пишемо лише те, що не
видно з читання одного файлу: як файли пов'язані між собою, чому прийнято
нетривіальне рішення, операційні знання (деплой/env/команди), яких більше
ніде нема. Сигнатури, алгоритми, розбір поле-за-полем — у докстрінгах й
коментарях самого коду, **не тут**: дубль неминуче розходиться з кодом
при наступній зміні (перевірено на власному досвіді — секція нижче вже раз
розрослася в повний переказ `gameplay/api.py`/`main.js` і застаріла). Коли
додаєш опис нового модуля/фічі — 1–3 речення (шлях, відповідальність,
cross-file зв'язок), деталі лишай коду; для нової фічі повний дизайн іде в
`docs/superpowers/specs/`, не сюди.

## Що це

Браузерна гра «маджонг-пасьянс»: поле — одна з кількох класичних розкладок (Cat/Crab/Dragon/Spider/Turtle, `layouts/*.layout`) на **144 кістки** (повний маджонг-набір: 34 звичайні види × 4 копії + 8 бонусних квітів/сезонів × 1), розклад **гарантовано розв'язний**. Форма поля (яка розкладка) обирається гравцем у модалці нової гри, ідентична для 144-кісткового набору незалежно від обраної форми — див. `gameplay/layouts.py`. Координати — пів-тайлова сітка (як у справжньому kmahjongg): звичайна кістка стоїть на парних координатах, а пік/виступи "голова-хвіст" — на непарних, точно між сусідами, без наближень. Бонусні види матчаться **wildcard-групами** (будь-яка квітка ↔ квітка, будь-який сезон ↔ сезон). Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/` (найновіше — `2026-07-29-tailwind-dom-ui-migration.md`), `docs/superpowers/plans/`.

## Стиль коду (Python)

Для структур даних завжди `ninja.Schema` (або pydantic `BaseModel`), ніколи `namedtuple`/`@dataclass` — єдиний стиль моделей у проєкті (`gameplay/schemas.py`, `config/schemas.py`, `gameplay/layouts.py: Layout`).

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- **django-ninja** — увесь JSON/HTTP API проєкту (жодного plain Django view/`JsonResponse` — лише `admin/` (стандартна Django-адмінка) і `''` (рендер HTML-сторінки гри) лишаються поза ninja, бо це не API).
- Проєкт Django: `config/` (settings/urls/api/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями. Phaser — локальний файл `static/vendor/phaser.min.js`. **Збірка JS**: `templates/game.html` завжди вантажить **один** `static/game/bundle.js` (жодного `{% if debug %}`-розгалуження), який `esbuild` склеює з графа модулів `static/game/*.js`. Локально — `esbuild --watch` (`scripts/dev.sh`, без `--minify`, з `--sourcemap` заради читаних стектрейсів/брейкпоінтів у devtools на реальних вихідних файлах); прод — мінімізований, без sourcemap, на етапі Docker-білда (окремий `node`-стейдж `jsbuild` у `Dockerfile`). І `bundle.js`, і `bundle.js.map` — build-артефакти, у git не комітяться (`.gitignore`); dev-версія і prod-версія ніколи не існують одночасно (різні контексти запуску), тож конфлікту імені файлу нема.
- **CSS — Tailwind CSS v4** (`assets/tailwind.src.css` → зібраний `static/game/tailwind.css`, теж build-артефакт поза git). На відміну від esbuild, Tailwind-CLI резолвить `@import "tailwindcss"` як звичайний Node-пакет, тож голого `npx --yes` (як для esbuild/Biome) не досить — у корені є мінімальний `package.json`/`package-lock.json` (`node_modules/` у `.gitignore`). `Dockerfile: jsbuild`-стейдж робить `npm ci`, потім збирає обидва — і `bundle.js`, і `tailwind.css`; локально — `npx @tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css --watch=always` поруч із `runserver` (див. Локальна розробка нижче). `@source` у `assets/tailwind.src.css` сканує і `templates/**/*.html`, і `static/game/*.js` (класи, що пишуться лише з JS — `.open`/`.you`/`.current-tag` тощо), тому `jsbuild`-стейдж копіює й `templates/`. Дизайн/пастки — `docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md`. Кешбастинг — штатний `whitenoise.storage.CompressedManifestStaticFilesStorage` (хеш в імені файлу, працює однаково для JS і CSS); whitenoise на `collectstatic` генерує `.gz` **і `.br`** для кожного статик-файла (brotli — залежність `brotli` у `pyproject.toml`; без неї був би лише gzip) і за `Accept-Encoding` віддає найменший варіант.
- **`package.json` має і `devDependencies` (Tailwind — build-time, у прод-образ не входить), і `dependencies`** (`@dicebear/core`+`@dicebear/collection` — реально ship-иться в `bundle.js`, `static/game/avatar.js` їх імпортує). `npm install` тому обов'язковий і для локальної розробки, не лише для Docker-білда.

## Структура гри

> Нижче — **карта**, не переказ реалізації: що де лежить, як файли пов'язані
> між собою і чому прийнято нетривіальне рішення там, де це не видно з
> самого файлу. Деталі (сигнатури, алгоритми, поле-за-полем) — у
> докстрінгах/коментарях кожного файлу, тут вони свідомо не дублюються (щоб
> не розходитись при зміні коду).

### Backend API (django-ninja)

- `config/api.py` — єдиний проєктний `NinjaAPI` (`/api/`): фонове фото,
  версія білда, монтує `gameplay.api.router` під `/game`. `CsrfOnly` —
  auth-заглушка, що пускає анонімів, але вимагає звичайний Django CSRF на
  unsafe-запитах; успадковується всіма підключеними роутерами.
  Версія білда (хеш `collectstatic`-маніфесту) звіряється клієнтом перед
  стартом партії (`scene.js: startGame()`) — фікс stale-кешу для
  standalone-PWA на iOS/macOS, де вікно може тижнями не оновлюватись;
  свідомо без service worker.
- `config/schemas.py` — ninja-схеми для `config/api.py`.
- `layouts/*.layout` (корінь проєкту) — форми полів у рідному форматі
  kmahjongg, дослівно з [KDE kmahjongg](https://invent.kde.org/games/kmahjongg)
  (GPL, атрибуція в кожному файлі). Формат парсить `gameplay/layouts.py`
  (деталі — в докстрінгу модуля). Приймаються лише 144-кісткові розкладки.
- `gameplay/` — Django-застосунок серверної генерації поля, антиріт-
  валідації партії, довічної статистики й щоденного турніру:
  `layouts.py` (парсер `.layout`), `board.py` (правило вільності/матчинг —
  форми поля не знає, лише координатну систему), `generator.py` (генерація
  гарантовано розв'язного поля), `daily.py` (детермінований щоденний
  виклик турніру), `models.py` (`GameSession`/`Profile`), `middleware.py`
  (резолвить гравця з куки `mahjong_player`), `stats.py` (довічні
  лічильники), `schemas.py`, `api.py` (усі ендпоінти). `GameSession.user`
  nullable лише заради безболісної міграції вже існуючих рядків (новий код
  завжди проставляє). Статистику атрибутує гравець, що СТАРТУВАВ партію
  (`session.user`), не обов'язково той, хто робить поточний запит.
  Rate-limit на IP через `CF-Connecting-IP` (продакшен за Cloudflare Tunnel
  — `REMOTE_ADDR` бачив би саму адресу проксі). Дизайн/план:
  `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`,
  `docs/superpowers/specs/2026-07-28-daily-tournament-design.md`.
  `Profile.display_name` — вільне (без унікальності) ім'я гравця; `daily.py:
  nickname_for(profile)` — єдине джерело "як показати гравця" (тулбар +
  лідерборд турніру), з фолбеком на `Player #xxxx`, якщо ім'я не задане.
  Те саме ім'я — і сід клієнтського DiceBear-аватара (`static/game/
  avatar.js`), окремого поля-сіда нема.
- `static/game/board.js` — модель поля для клієнтського інтерактиву
  (рендер/кліки/undo/детекція глухого кута); авторитетна перевірка — на
  сервері (`gameplay/board.py`). Форми поля тут **не** зашито — позиції
  приходять із серверного `layout`, ширина/висота/шари виводяться з нього ж
  (`scene.js: applyBoardDims`), не з констант модуля. Чистий модуль, без
  Phaser/DOM.
- `static/game/stats.js` — довічні показники тепер на сервері
  (`gameplay/models.py: Profile.stats`); модуль лишає презентаційні
  хелпери й одноразовий читач legacy `localStorage`-блоба для переносу на
  сервер. Чистий модуль, без Phaser/DOM.
- `static/game/audio.js` — WebAudio-синтез звукових ефектів (клік/пара/
  помилка/скасування/підказка/shuffle/перемога/програш) — осцилятори й
  шум, без семплів (нуль файлів, нуль ліцензій). Перемикач у
  `#profile-modal` (`ui-dom.js`), стан — `localStorage['mahjong.sound']`,
  окрема преференція від `scene.js: reducedMotion`. `AudioContext`
  створюється ліниво (лише на перший клік — політика autoplay браузерів),
  ін'єктована через параметр заради `node --test`. Чистий модуль, без
  Phaser/DOM.
- `static/game/avatar.js` — рендер DiceBear-аватара (`@dicebear/core` +
  стиль `funEmoji` з `@dicebear/collection`, npm-залежності, реально
  бандляться в `bundle.js` — не HTTP API). Seed = ім'я гравця
  (`gameplay/daily.py: nickname_for` — той самий рядок, що показаний як
  ім'я). Мемоізація SVG за `ім'я|розмір`. Чистий модуль, без Phaser/DOM.
- `static/game/sync.js` — тонкий HTTP-клієнт до `config/api.py`/
  `gameplay/api.py`. Ідентичність гравця — кука `mahjong_player` (HttpOnly,
  підписана сервером), їде автоматично з кожним fetch; CSRF-токен — з
  `window.MAHJONG_CSRF`, заголовок `X-CSRFToken`.
- `static/game/scene.js` — Phaser-сцена (`MainScene`): тайли, layout/resize,
  сесія гри (start/resume/finish/shuffle/undo/hint). Канвас малює **лише
  дошку** — тулбар/смуга статусу/кредит фотографа/модалки тепер DOM
  (`templates/game.html`, `ui-dom.js`). Поле для нової партії завжди
  тягнеться з сервера (без мережі гра не починається). Стан UI —
  Publisher/Subscriber через `this.registry` (Phaser `DataManager`):
  бізнес-логіка ніде не викликає методів на кшталт «відкрий модалку» — лише
  пише факт (`registry.set(...)`), `ui-dom.js` підписаний і вирішує, що
  показати. Партія переживає перезавантаження сторінки — знімок у
  `localStorage` (`persistGame`/`tryResumeGame`), звіряється з сервером
  перед відновленням. Ресайз ловиться через `ResizeObserver` на
  `#game-container`, не `window.resize` — DOM-тулбар/статус-бар можуть
  змінити висоту суто внутрішнім reflow (перенесення кнопки, зміна довжини
  лейбла при зміні мови), без жодної події `window resize`.
- `static/game/effects.js` — анімаційні хелпери для `scene.js`: кожна
  функція бере `scene` першим аргументом (deal-in, політ пари в лічильник,
  shuffle-flip, glow/hover/press/error, кінцевий ефект перемоги/програшу,
  частинки) — винесені зі сцени, щоб `MainScene` лишався про сесію/layout,
  не про tween-деталі.
- `static/game/render-constants.js` — базові (design-px) пропорції/кольори/
  тюнінг ефектів для `scene.js`/`effects.js`. Після переходу на sprite-рендер
  (готовий oblique-арт Cangjie6) і нативне розрішення геометрія тайла тут
  більше не «запечена» — розмір і кроки сітки рахуються динамічно в
  `scene.js` (`computeLayout`) з реального розміру вікна; тут лишились лише
  базові значення, помножені на DPR у сцені. Чистий модуль, без Phaser/DOM.
- `static/game/ui-dom.js` — DOM-контролер тулбару/смуги статусу/кредиту
  фотографа/5 модалок (`templates/game.html`). Лідерборд турніру будує
  `<li>` через DOM API (`createElement`/`textContent`), не `innerHTML` —
  `entry.nickname` тепер довільний текст, обраний гравцем (POST
  `/api/game/profile`), тож інтерполяція в HTML-рядок була б stored XSS.
  Підписується на
  `scene.registry` (**і `changedata`, і `setdata`** — Phaser шле
  `changedata` лише від ДРУГОГО запису ключа, перший завжди йде як `setdata`
  без пер-ключового варіанта; пропустити це — і початковий рендер кожного
  щойно заведеного ключа реєстру мовчки не станеться).
- `static/game/main.js` — тонка точка входу: збирає `Phaser.Game` з
  `MainScene`, експортує `window.mahjongGame` (доступ до гри для
  дебагу/тестів).
- `templates/game.html` — сторінка гри (корінь `/`): `<header>`-тулбар +
  `<main id="game-container">` (канвас, лише дошка) + `<footer>`-смуга
  статусу, усі три — flex-колонка в `<body>`; далі 5 DOM-модалок (нової
  гри/статистики/турніру/глухого кута/гравця). Остання кнопка тулбару
  (`#btn-profile`, аватар+ім'я) — єдина не `flex-1`: `ml-auto` притискає її
  до правого краю, решта п'ять кнопок ліворуч ділять простір порівну.
  Інжектить
  `window.MAHJONG_CSRF`/`MAHJONG_VERSION`/`MAHJONG_LANG`. Стилі — Tailwind
  (`assets/tailwind.src.css` → зібраний `tailwind.css`, єдиний `<link>`
  без `{% if debug %}`); шаблон свого `<style>` не містить — жоден
  `{% trans %}` усередині CSS неможливий (статика не проходить через
  шаблонізатор), тож підпис "← current" у статистиці рендерить
  `ui-dom.js: renderStatsModal()` через `gettext()`, а не CSS `::after`.
- `static/game/tiles/*.svg` — 42 oblique-3D тайли (Cangjie6, **CC BY-SA
  4.0**, атрибуція обов'язкова — див. `static/game/tiles/CREDITS.md`).
  Растеризуються з SVG у `CanvasTexture` в рантаймі, без текстурного
  атласу.
- `static/game/tiles/*.png` + `Front.png` — старий CC0-набір FluffyStuff;
  гра ним більше не рендерить кістки, лишився лише як джерело для
  `scripts/gen_icons.py`.
- `static/icons/*` — favicon/PWA-іконки, генеруються `scripts/gen_icons.py`
  (Pillow — ефемерна залежність, `uv run --with pillow ...`).

### Нюанси рендеру (не ламати)

Деталі й обґрунтування — в коментарях безпосередньо біля відповідного коду
в `static/game/scene.js`/`effects.js`; тут лише список, щоб не зламати
випадково:

- **Depth-формула** в `addTileSprite` (`z*10000 + (boardHeight-1-y) + x`,
  вага x/y **однакова**) — критична саме для діагональних пів-тайлових
  сусідів (пік, голова/хвіст), інакше кістки перекриваються хаотично.
- **Кістка = один спрайт із готовим oblique-3D-артом** — об'єм намальований
  у самому SVG, гра не пече власний 3D-корпус.
- **Текстури растеризуються з SVG у рантаймі** (`rasterizeTiles`) і
  вантажаться як **blob-URL Image**, не `<img src>` — інакше WebGL-канвас
  «отруюється» (tainted) і відмовляється від текстури.
- **Нативне розрішення** (`Scale.NONE` + ручний DPR-скейл), не
  `Scale.FIT` — світові координати завжди в device-px.
- **Клік по кістці** — один сценовий `gameobjectdown`-обробник, не
  `pointerdown` на кожен спрайт (`create()`).
- **DOM-модалка НЕ блокує клік по канвасу під собою** — Phaser сам робить
  hit-test повз DOM z-index; єдиний захист — явний guard
  `if (this.registry.get('modal')) return;` у КОЖНОМУ обробнику кліку
  (сценовому і в кожній кнопці тулбару окремо). Тулбар/смуга статусу цю
  пастку взагалі оминають — вони DOM flex-сусіди канваса
  (`templates/game.html`), а не оверлей поверх нього, тож жодна кістка під
  ними ніколи не опиняється.
- **`#game-container` не повинен мати власного `height`** у Tailwind-джерелі
  (`assets/tailwind.src.css`) — розмір рахує flexbox (`<main class="flex-1
  min-h-0">` між `<header>`/`<footer>`). Tailwind-каскадні layers
  (`base`→`components`→`utilities`) визначають пріоритет ПОВЕРХ звичайної
  специфічності CSS: явний `height` у `base`, навіть застарілий/помилковий,
  завжди переміг би `flex-1` з `utilities`.

## Локальна розробка

```
uv sync                      # встановити залежності з uv.lock
npm install                  # один раз — devDependencies для esbuild/Tailwind watchers
uv run manage.py migrate
./scripts/dev.sh             # runserver + esbuild --watch + Tailwind --watch, один Ctrl-C
```

`scripts/dev.sh` — тонка обгортка: піднімає esbuild- і Tailwind-watcher у
фоні (trap на EXIT гасить обидва), а `runserver` лишає на передньому плані
— Ctrl-C зупиняє все. `static/game/bundle.js`/`tailwind.css` без цього
скрипту не існують (build-артефакти, `.gitignore`), тож просто
`manage.py runserver` без `dev.sh` віддасть 404 на JS/CSS. Якщо потрібен
лише один із watcher'ів нарізно — команди:

```
uv run manage.py runserver
npx --yes esbuild@0.24.2 static/game/main.js \
  --bundle --sourcemap --format=esm --outfile=static/game/bundle.js --watch=forever
npx @tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css --watch=always
```

Додавання залежностей: `uv add <package>` (прод) / `uv add --dev <package>` (dev-інструменти, лінтери, тести).

## Локалізація

Штатний Django gettext-i18n (`uk` + `en`), msgid — **англійською** (ідіоматичний Django),
переклади — `locale/{uk,en}/LC_MESSAGES/{django,djangojs}.po`. Дефолт для нового
відвідувача без куки й без збігу `Accept-Language` — українська (`LANGUAGE_CODE = 'uk'`,
`config/settings.py`). Перемикач мови — пікер (`🌐 UA`/`🌐 EN`, той самий
радіо-кнопковий стиль `.newgame-option`, що й пікери у `#newgame-modal`) у
`#profile-modal` (`templates/game.html`, поруч із перемикачем звуку), не
окрема кнопка тулбару. Лише дві мови (`config/settings.py: LANGUAGES`), тож
це пікер із двох варіантів, не `<select>`: підсвічує ПОТОЧНУ мову
(`ui-dom.js`: `langButtons`, порівняння з `window.MAHJONG_LANG`), клік по
неактивній перемикає. `window.MAHJONG_LANG` (з
`{% get_current_language %}`, `templates/game.html`) — джерело поточної мови для
JS. Клік шле POST у Django `set_language` (`static/game/sync.js: setLanguage()`,
`config/urls.py: path('i18n/', include('django.conf.urls.i18n'))`) і перезавантажує
сторінку — **без** `i18n_patterns`, URL кореня `/` лишається чистим (важливо для
standalone-PWA/`start_url`). Активна партія переживає перезавантаження без втрат
(`tryResumeGame()` — той самий шлях, що й для звичайного reload/resume).

Динамічний текст (лічильник підказок/скасувань, "Залишилось: N", рядки статистики,
турнірна інформація — `ui-dom.js`/`scene.js`) і досі йде через Django
**`JavaScriptCatalog`** (`config/urls.py:
path('jsi18n/', JavaScriptCatalog.as_view())`, без `packages=` — каталог живе в
проєктному `locale/`, не всередині `gameplay/locale/`), підключений у `game.html`
**класичним** `<script>` (не `type="module"`) **перед** модульним бандлом — глобальні
`gettext`/`interpolate` мають бути визначені до виконання `main.js`/`bundle.js`.
Статичні лейбли тулбару/модалок (окрім лічильників) — тепер звичайний Django
`{% trans %}` прямо в `templates/game.html` (domain `django`, окремий від
`djangojs` — той самий текст в обох каталогах потребує окремого перекладу в
кожному).
Емодзі-префікси (`🆕`, `💡`, `🏆`, ...) свідомо лишаються **поза** `gettext()`/
`{% trans %}` — вони мовонезалежні, перекладати нема чого.

Назви розкладок (`Cat`/`Crab`/`Dragon`/`Spider`/`Turtle`, з `#`-коментарів `.layout`-файлів) кешуються
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
  --ignore='staticfiles/*' --ignore='.venv/*' --ignore='node_modules/*'
uv run manage.py makemessages -d djangojs -l uk -l en \
  --ignore='static/vendor/*' --ignore='static/game/bundle.js' \
  --ignore='staticfiles/*' --ignore='.venv/*' --ignore='node_modules/*'
uv run manage.py compilemessages --locale=uk --locale=en   # для локальної перевірки
```

## Тести

Клієнтська логіка гри тестується без браузера й без npm — вбудованим test runner Node:

```
node --test 'tests/*.test.js'
```

(Форма `node --test tests/` не працює — node трактує каталог як модуль.) Покрито: правило вільності, матчинг/undo, глухий кут, replay лога ходів, трансформери й localStorage-обгортку статистики (`stats.js`), увімк/вимк звуку та lazy-ініціалізацію `AudioContext` через ін'єктований дубль (`audio.js`). Форма поля (яка розкладка, розв'язність генерації) клієнтськими тестами більше не покривається — вона повністю на сервері (нижче), `board.js` тепер знає лише координатну систему, не конкретну фігуру. `scene.js`/`effects.js`/`ui-dom.js` (Phaser + DOM) юніт-тестами не покриваються — перевіряти в браузері.

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

- **JS + CSS (`Biome`)** — гониться через `npx` з піном версії (той самий
  підхід, що й `esbuild` у `Dockerfile: jsbuild`; Biome сам по собі не
  потребує локального `node_modules` — на відміну від Tailwind, див. Стек
  вище), конфіг — `biome.json` (лінтить `static/game/**/*.js`,
  `static/game/**/*.css` і `tests/**/*.js`, виключає build-артефакти
  `bundle.js`/`tailwind.css` і джерело `assets/tailwind.src.css` — останнє
  використовує Tailwind-специфічні at-rules (`@source`/`@theme`/`@apply`),
  яких Biome's CSS-лінтер (стандартний CSS, без діалектів) не знає;
  `static/vendor/` не мапиться жодним include-патерном, тож теж поза
  скоупом). Окремий CSS-інструмент (stylelint тощо) не заводили; CSS-
  форматтер лишається вимкненим (Biome-дефолт), критерій — лише `lint`:
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
- `PEXELS_API_KEY` — ключ Pexels API для фонового фото (`config/api.py`); без нього
  ендпоінт фону мовчки вимикається (`if not settings.PEXELS_API_KEY`), решта гри
  працює нормально.
- `DATABASE_URL` — опційно перекриває дефолтний sqlite (`dj_database_url.config()`,
  дефолт `sqlite:///db.sqlite3`).

Локально можна не задавати — є дефолти для розробки (DEBUG=True, insecure SECRET_KEY,
sqlite, фон вимкнений без ключа Pexels).

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
