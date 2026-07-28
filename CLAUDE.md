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

Браузерна гра «маджонг-пасьянс»: поле — одна з кількох класичних розкладок (Turtle/Dragon/Cat) на **144 кістки** (повний маджонг-набір: 34 звичайні види × 4 копії + 8 бонусних квітів/сезонів × 1), розклад **гарантовано розв'язний**. Форма поля (яка розкладка) обирається гравцем у модалці нової гри, ідентична для 144-кісткового набору незалежно від обраної форми — див. `gameplay/layouts.py`. Координати — пів-тайлова сітка (як у справжньому kmahjongg): звичайна кістка стоїть на парних координатах, а пік/виступи "голова-хвіст" — на непарних, точно між сусідами, без наближень. Бонусні види матчаться **wildcard-групами** (будь-яка квітка ↔ квітка, будь-який сезон ↔ сезон). Гра живе на корені `/`. Дизайн і план: `docs/superpowers/specs/` (найновіше — `2026-07-28-daily-tournament-design.md`), `docs/superpowers/plans/`.

## Стиль коду (Python)

Для структур даних завжди `ninja.Schema` (або pydantic `BaseModel`), ніколи `namedtuple`/`@dataclass` — єдиний стиль моделей у проєкті (`gameplay/schemas.py`, `config/schemas.py`, `gameplay/layouts.py: Layout`).

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- **django-ninja** — увесь JSON/HTTP API проєкту (жодного plain Django view/`JsonResponse` — лише `admin/` (стандартна Django-адмінка) і `''` (рендер HTML-сторінки гри) лишаються поза ninja, бо це не API).
- Проєкт Django: `config/` (settings/urls/api/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).
- Фронтенд гри: **Phaser 3.90** vanilla JS ES-модулями. Phaser — локальний файл `static/vendor/phaser.min.js`. **Збірка JS**: локальна розробка вантажить сирі ES-модулі `static/game/*.js` напряму (жодного локального білда — редагуй `.js`, онови сторінку); прод віддає **один мініфікований `bundle.js`**, який `esbuild` склеює з графа модулів на етапі Docker-білда (окремий `node`-стейдж `jsbuild` у `Dockerfile`). Перемикання — `{% if debug %}` у `templates/game.html`. `bundle.js` — build-артефакт, у git не комітиться (`.gitignore`). Кешбастинг — штатний `whitenoise.storage.CompressedManifestStaticFilesStorage` (хеш в імені файлу); whitenoise на `collectstatic` генерує `.gz` **і `.br`** для кожного статик-файла (brotli — залежність `brotli` у `pyproject.toml`; без неї був би лише gzip) і за `Accept-Encoding` віддає найменший варіант.

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
  стартом партії (`main.js: startGame()`) — фікс stale-кешу для
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
- `static/game/board.js` — модель поля для клієнтського інтерактиву
  (рендер/кліки/undo/детекція глухого кута); авторитетна перевірка — на
  сервері (`gameplay/board.py`). Форми поля тут **не** зашито — позиції
  приходять із серверного `layout`, ширина/висота/шари виводяться з нього ж
  (`main.js: applyBoardDims`), не з констант модуля. Чистий модуль, без
  Phaser/DOM.
- `static/game/stats.js` — довічні показники тепер на сервері
  (`gameplay/models.py: Profile.stats`); модуль лишає презентаційні
  хелпери й одноразовий читач legacy `localStorage`-блоба для переносу на
  сервер. Чистий модуль, без Phaser/DOM.
- `static/game/sync.js` — тонкий HTTP-клієнт до `config/api.py`/
  `gameplay/api.py`. Ідентичність гравця — кука `mahjong_player` (HttpOnly,
  підписана сервером), їде автоматично з кожним fetch; CSRF-токен — з
  `window.MAHJONG_CSRF`, заголовок `X-CSRFToken`.
- `static/game/main.js` — Phaser-сцена: рендер, кліки, тулбар і смуга
  статусу (canvas-об'єкти, не DOM), модалки старту/статистики/турніру/
  глухого кута. Поле для нової партії завжди тягнеться з сервера (без
  мережі гра не починається). Стан UI — Publisher/Subscriber через
  `this.registry` (Phaser `DataManager`): бізнес-логіка ніде не викликає
  методів на кшталт «відкрий модалку» — лише пише факт (`registry.set(...)`),
  єдиний підписник (`renderModal()`) вирішує, що показати. Партія переживає
  перезавантаження сторінки — знімок у `localStorage`
  (`persistGame`/`tryResumeGame`), звіряється з сервером перед
  відновленням. `window.mahjongGame` — доступ до гри для дебагу/тестів.
- `templates/game.html` — сторінка гри (корінь `/`): `#game-container`
  (канвас) + DOM-модалки (нової гри/статистики/турніру/глухого кута).
  Тулбар і смуга статусу — **не DOM**, рендеряться в канвасі. Інжектить
  `window.MAHJONG_CSRF`/`MAHJONG_VERSION`/`MAHJONG_LANG`.
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
в `static/game/main.js`; тут лише список, щоб не зламати випадково:

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
  (сценовому і в кожній кнопці тулбару окремо).
- **`#game-container` має фіксований розмір**, не контент-залежний —
  інакше зворотний зв'язок canvas↔container і ривки при resize.

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
