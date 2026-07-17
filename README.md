# Mahjong

Браузерний маджонг-пасьянс: поле «Turtle» 12×8×3 (136 кісток, автентична riichi-колода 34×4), кожен розклад гарантовано розв'язний.

- **Гра**: Phaser 3, vanilla JS ES-модулі, без білд-системи. Клієнтський інтерактив (рендер, кліки, undo) — чисті модулі в `static/game/`.
- **Бекенд**: Django 6 + **django-ninja** (весь JSON API: генерація поля, антирід-валідація партії реплеєм ходів, фонове фото) — сервер авторитетний для розкладки, легальності ходів і часу партії. Django-в'юхи лишаються лише для сторінки (`TemplateView`) й адмінки.
- **Тайли**: [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles), CC0.

## Запуск

```bash
uv sync
uv run manage.py migrate
uv run manage.py runserver
```

Гра — на http://127.0.0.1:8000/.

## Тести

```bash
node --test 'tests/*.test.js'   # клієнт (Phaser-незалежна логіка)
uv run manage.py test           # сервер (gameplay/, config/)
```

Деталі розробки та деплою — у [CLAUDE.md](CLAUDE.md).
