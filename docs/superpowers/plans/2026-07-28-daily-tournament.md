# Щоденний турнір — Implementation Plan

**Статус:** реалізовано. Дизайн: [2026-07-28-daily-tournament-design.md](../specs/2026-07-28-daily-tournament-design.md).

**Goal:** Додати щоденний турнір (спільний детермінований розклад на день +
лідерборд за часом зі штрафами), не змішавши його з довічною статистикою
звичайної гри й не ускладнивши серверну модель понад необхідне.

**Architecture:** Турнірна спроба — це та сама `GameSession`, позначена
непорожнім `daily_date` (без окремої моделі/таблиці). Розклад/рівень/seed
детерміновані від дати (`gameplay/daily.py: daily_challenge`), тож усі
гравці дня грають ідентичний розклад без жодного стану в БД для самого
розкладу. Один виграний рядок на день на гравця блокує повторні спроби
(частковий `UniqueConstraint`); програні спроби можна повторювати
необмежено — той самий детермінований розклад щоразу. Лідерборд і рахунок
рахуються прямими запитами до `GameSession`, без дублювання в
`Profile.stats` — і саме тому турнір ізольований від довічної статистики
звичайної гри за конструкцією, а не патчем поверх.

## Global Constraints

- Українські коментарі в новому Python/JS-коді — суперечить `CLAUDE.md`
  («усі коментарі в коді — англійською»); у цьому проєкті коментарі саме
  англійською, на відміну від плану `2026-07-17` (там була інша конвенція).
- `uv run ruff check .`, `npx --yes @biomejs/biome@2.5.5 lint static/game
  tests`, `uv run manage.py test`, `node --test 'tests/*.test.js'` — усі
  чотири мають проходити чисто перед завершенням будь-якого завдання.
- Ніякого нового окремого лічильника турнірної статистики в
  `Profile.stats` — YAGNI, дані вже є в `GameSession`.

---

### Task 1: Детермінований щоденний виклик + серверна модель

**Files:**
- Create: `gameplay/daily.py`
- Modify: `gameplay/models.py` (`GameSession`: `hints`, `undos`, `daily_date`,
  `score_ms`, `Meta.constraints`/`indexes`)
- Create: `gameplay/migrations/0004_gamesession_daily_date_gamesession_hints_and_more.py`
  (auto-generated)

- [x] `daily_challenge(date) -> (board_slug, level, seed)` — чиста функція,
  без побічних ефектів; борд ротується по днях, рівень фіксований `'normal'`
  (`DAILY_LEVEL`), seed — `f'daily-{date.isoformat()}'`.
- [x] `GameSession` + 4 поля, індекс `(daily_date, score_ms)` для
  лідерборду, `UniqueConstraint(user, daily_date)` — **початкова версія**
  (одна спроба на день, без retry).

### Task 2: Ендпоінти `GET /daily` / `POST /daily/start`, схеми, тести

**Files:**
- Modify: `gameplay/api.py`, `gameplay/schemas.py`, `gameplay/tests.py`

- [x] `daily_info` / `start_daily` — перша версія: одна спроба на день,
  статус гравця з однієї стрічки (`'new'|'active'|'won'|'lost'`).
- [x] `DailyResponse`/`DailyStartResponse`/`LeaderboardEntry` схеми.
- [x] `finish_game` — гілка для `session.daily_date is not None`: рахунок
  зі штрафами F-виразом, `daily_rank` у відповіді.
- [x] `bump_stat` — атомарний інкремент `hints`/`undos` лише для турнірних
  сесій.
- [x] Тести детермінізму/ідемпотентності/рахунку/рейтингу.

### Task 3: Фронтенд — тулбар, модалка турніру, sync.js

**Files:**
- Modify: `static/game/sync.js`, `static/game/main.js`, `templates/game.html`

- [x] `fetchDaily()`/`startDaily()` у `sync.js`.
- [x] Кнопка «🏆 Турнір» у тулбарі, `#daily-modal` + рендер
  (`renderDailyModal`), запуск через `playDaily()`.
- [x] `isDaily`-прапорець крізь `persistGame`/`tryResumeGame` — резюм партії
  після перезавантаження сторінки коректно відрізняє турнірну сесію.

### Task 4: Локалізація — фіксація рівня складності турніру

**Files:** `gameplay/daily.py`, `gameplay/tests.py`, `static/game/main.js`,
`locale/{uk,en}/LC_MESSAGES/*.po`

- [x] `daily_challenge` перестав ротувати рівень — завжди `'normal'`
  (рефлексія: один порівнюваний лідерборд важливіший за різноманіття
  складності).
- [x] Прибрано показ рівня в модалці турніру (`renderDailyModal`) — раз він
  завжди один, показувати нема чого.

### Task 5: Retry-after-loss + консистентна модалка нової гри

**Files:** `gameplay/models.py`, нова міграція `0005_...`, `gameplay/api.py`,
`gameplay/tests.py`, `static/game/main.js`, `templates/game.html`

- [x] `UniqueConstraint` ослаблено до `one_daily_win_per_user_per_day`
  (частковий, лише `won=True`) — довільна кількість програних спроб
  дозволена, лише друга перемога того самого дня блокується на рівні БД.
- [x] `daily_info`/`start_daily` переписані на роботу з набором сьогоднішніх
  рядків, а не з однієї стрічки (`_daily_setup`).
- [x] Кнопка «🔁 Переграти» в deadlock-модалці (`replayGame()`) — і для
  звичайної гри, і для турніру: реєструє програш, одразу стартує нову
  партію без проміжного екрана результату.
- [x] Кнопки складності в модалці «Нова гра» стали чистими селекторами
  (як і кнопки розкладки); окрема кнопка «▶️ Почати» реально запускає
  партію.
- [x] Тести на retry-цикл (програш → новий рядок → та сама розкладка →
  перемога блокує подальші спроби).

### Task 6: `/code-review simplify` — прибирання дублювання

**Files:** `gameplay/api.py`, `gameplay/daily.py`, `gameplay/schemas.py`,
`gameplay/tests.py`, `static/game/sync.js`, `static/game/main.js`

- [x] Схеми `Daily*`/`LeaderboardEntry`/`FinishResponse.daily_rank`
  повернуто до звичайного snake_case (без per-schema camelCase-аліасів,
  що розходились із рештою `schemas.py`) — маппінг у camelCase залишився
  на боці клієнта (`sync.js`), як і для решти ендпоінтів.
- [x] `_daily_setup`/`_board_payload`/`_daily_rank` — спільна логіка
  `daily_info`/`start_daily`/`finish_game`, прибрано дублювання запитів.
- [x] `bump_stat` більше не пише зайвий UPDATE для звичайних (не турнірних)
  сесій; `daily_info` пропускає зайвий `COUNT` для `total_participants`,
  коли сторінка лідерборду не заповнена повністю.
- [x] `_enterFreshGame()` — спільний хвіст `startGame()`/`playDaily()` у
  `main.js` (клієнтські sprite-скидання/`enterGame`/рендер).
- [x] Видалено мертвий код (`daily_score_ms`, зайве `sorted()` над уже
  відсортованим `load_layouts()`).

### Task 7: Ізоляція статистики турніру від довічної статистики звичайної гри

**Files:** `gameplay/api.py`, `gameplay/tests.py`, `static/game/main.js`
(коментар)

- [x] `_lifetime_stats_after(profile, session, mutator)` — єдина точка
  запису в `Profile.stats`; для турнірної сесії повертає блоб без змін,
  ніколи не викликаючи `mutator`. Застосовано в `finish_game`, `bump_stat`,
  `shuffle_game`.
- [x] Тест-інваріант `test_daily_play_never_touches_lifetime_normal_stats`.
- [x] Виправлено неточний коментар у `replayGame()` (main.js): «сесія
  просто підхопиться назад» правдиве лише для турнірної гілки, не для
  звичайної.

## Verification

```
uv run ruff check .
npx --yes @biomejs/biome@2.5.5 lint static/game tests
uv run manage.py test
node --test 'tests/*.test.js'
```

Ручна перевірка в браузері (усі сценарії пройдено): старт турніру, глухий
кут → «Переграти» (той самий розклад, лічильник партій оновлюється),
перемога → рахунок/місце в лідерборді, повторний вхід у турнір після
перемоги → «фінішовано», нова модалка «Нова гра» (вибір без старту + окрема
кнопка «Почати»).
