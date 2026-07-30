# Переїзд UI-обв'язки на DOM + Tailwind CSS, розбиття main.js

Дата: 2026-07-29. Статус: реалізовано.

## Мета

До цієї зміни ~95% UI гри малювалось на Phaser-канвасі: тулбар, смуга
статусу, кредит фотографа — усе було `Phaser.Text`/rectangle/container
об'єктами (`static/game/main.js`). Єдиний реальний DOM — 4 модалки
(`templates/game.html`), стилізовані окремим `app.css`.

Плани на ріст DOM-частини гри (нові панелі/меню поза канвасом) зробили
поточну архітектуру тісною: додавати DOM-UI означало або дублювати логіку
рендеру (канвас + DOM), або переносити частину UI з канваса в DOM. Заразом
`main.js` розрісся до 1821 рядка, змішуючи сцену, DOM-обв'язку, ігрову
сесію й анімації в одному файлі.

Рішення:
1. Перенести **тулбар + смугу статусу + кредит фотографа + модалки** в DOM;
   канвас віднині малює **лише** дошку (кістки/ефекти/фон).
2. Стилізувати цей DOM через **Tailwind CSS v4**, зібраний тим самим
   Docker-стейджем, що вже збирає `bundle.js` (esbuild).
3. Розбити `main.js` на `scene.js`/`effects.js`/`ui-dom.js`/тонкий `main.js`.

## Межа канвас/DOM

**У канвасі (без змін):** кістки-спрайти, растеризація SVG, depth-сортування,
клік по кістці (єдиний сценовий `gameobjectdown`), усі анімації/ефекти
(роздача, політ пари в лічильник, flip при переміші, glow/hover/press/error,
кінцевий ефект перемоги/програшу), фонове фото + вуаль, уся ігрова логіка
сесії (правило вільності, матчинг, undo, дедлок, start/finish/shuffle).

**У DOM (нове):** тулбар (Нова гра/Підказка/Скасувати/Статистика/Турнір/
Мова), смуга статусу (залишилось/складність/довічна статистика), кредит
фотографа, 4 модалки.

Дві точки дотику канвас↔DOM:
- **Синхронізація стану** — гра як і раніше пише факти в `scene.registry`
  (Phaser DataManager); DOM-підписник (`ui-dom.js`) читає їх і оновлює
  `textContent` замість `setText`. Той самий Publisher/Subscriber, що і
  раніше — змінився лише рендер-таргет підписника.
- **Політ кістки в лічильник** (`removePair` → `flyToCenterThenDown` →
  `flyDownFromCenter`) — ціль тепер обчислюється з `getBoundingClientRect()`
  DOM-лічильника (`ui-dom.js: getCounterRect()`), перерахованого в
  world-space канваса (`scene.js: flightTarget()`:
  `(screenPx - canvasCssOrigin) * dpr`).

## Технічні пастки (для майбутніх змін у цій же ділянці)

- **`#game-container` не повинен мати власного `height`** у Tailwind-джерелі
  (`assets/tailwind.src.css`). Це `<main class="flex-1 min-h-0">` між
  `<header>`/`<footer>` — розмір рахує flexbox. Explicit `height` у
  `@layer base` (навіть некоректний/застарілий) переміг би `flex-1` —
  Tailwind-каскадні layers (`base`→`components`→`utilities`) визначають
  пріоритет ПОВЕРХ звичайної специфічності CSS: правило з `base`, що чіпляє
  ту саму властивість, завжди програє будь-якому правилу з `utilities`,
  байдуже наскільки те просте. Звідси ж наслідок: клас `.open` для модалок
  зроблений **не** через Tailwind `hidden`-утиліту (та живе в `utilities` і
  завжди переміг би), а власним правилом у `@layer components`.
- **Ресайз відстежується через `ResizeObserver` на `#game-container`, не
  `window.resize`** (`scene.js: create()`). DOM-тулбар/статус-бар можуть
  змінити висоту через суто внутрішній reflow (перенесення кнопки на другий
  рядок, зміна довжини лейбла при перемиканні мови) — жодна з цих подій не
  породжує `window resize`, а канвас має підхопити нову висоту контейнера.
- **Phaser `DataManager` не шле `changedata` на ПЕРШИЙ запис ключа** —
  лише `setdata` (без пер-ключового варіанта). Кожен ключ реєстру, що його
  читає `ui-dom.js` (`status`, `gameHints`, `allStats`, `modal`, ...),
  вперше пишеться десь під час завантаження/старту гри — без явної
  підписки і на `setdata` перший рендер кожного з них мовчки не стався б
  (стара канвасна версія цього не ловила, бо руками зашивала початковий
  текст у конструкторі й лише ОНОВЛЮВАЛА його через `changedata`).
  `ui-dom.js: createUiDom()` підписується на обидва.

## Збірка Tailwind

Tailwind v4 (`@import "tailwindcss"` у `assets/tailwind.src.css`) резолвить пакет
`tailwindcss` як звичайний Node-модуль — на відміну від esbuild, який не
потребує реального `node_modules` для голого `npx --yes`. Тому в корені
з'явився мінімальний `package.json`/`package-lock.json` (лише
`tailwindcss`+`@tailwindcss/cli`, запиновані версії, `node_modules/`
у `.gitignore`) — і Docker-стейдж `jsbuild` тепер робить `npm ci` перед
збіркою. `@source` у `assets/tailwind.src.css` сканує `templates/**/*.html` і
`static/game/*.js` (для класів на кшталт `.open`/`.you`/`.current-tag`,
що пишуться лише з JS) — тому `jsbuild`-стейдж копіює й `templates/`, не
лише `static/game/`. Локальна розробка: `npx @tailwindcss/cli -i
assets/tailwind.src.css -o static/game/tailwind.css --watch` поруч із
`runserver` (CLAUDE.md: Локальна розробка).

`assets/tailwind.src.css` живе поза `static/`, не в корені репо і не в
`static/game/` — задокументована пастка WhiteNoise+Tailwind, не власний
винахід: `collectstatic`-постпроцесор whitenoise переписує url()-подібні
токени в КОЖНОМУ `.css` під `static/` і падає з `MissingFileError` на
`@import "tailwindcss"`, сприймаючи його як биту відносну url()-посилання.
Той самий рецепт дає офіційна документація `django-tailwind-cli`: "do not
place your custom Tailwind configuration file within static file
directories... store custom configurations elsewhere in your project."

## Структура файлів після зміни

- `static/game/scene.js` — `MainScene`: тайли, layout/resize, сесія гри.
- `static/game/effects.js` — чисті(ish) хелпери `(scene, ...)`: deal-in,
  політ пари, shuffle-flip, glow/hover/press/error, кінцевий ефект,
  частинки.
- `static/game/ui-dom.js` — DOM-контролер тулбару/статус-бару/модалок,
  підписаний на `scene.registry`.
- `static/game/main.js` — тонка точка входу: збирає `Phaser.Game`,
  експортує `window.mahjongGame`.
- `assets/tailwind.src.css` — джерело Tailwind (`@theme`/`@layer
  base`/`@layer components`), увібрало структурні правила старого `app.css`
  (видалений).
- `static/game/render-constants.js` — без toolbar/status-bar констант
  (`TOOLBAR_H`/`STATUS_BAR_H`/`STATUS_BAR_BG*`), решта без змін.
