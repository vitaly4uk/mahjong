# Mahjong

Браузерний маджонг-пасьянс: поле 9×9×3 (242 кістки), кожен розклад гарантовано розкладається.

- **Гра**: Phaser 3, vanilla JS ES-модулі, без білд-системи. Логіка (модель поля, розв'язна генерація) — чисті модулі в `static/game/`.
- **Бекенд**: Django 6 віддає сторінку і статику (whitenoise).
- **Тайли**: [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles), CC0.

## Запуск

```bash
uv sync
uv run manage.py runserver
```

Гра — на http://127.0.0.1:8000/.

## Тести

```bash
node --test 'tests/*.test.js'
```

Деталі розробки та деплою — у [CLAUDE.md](CLAUDE.md).
