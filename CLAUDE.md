# CLAUDE.md

Контекст проєкту та інфраструктура для деплою mahjong.

## Стек

- **Django 6.0** + **uv** як пакетний менеджер.
- Проєкт Django: `config/` (settings/urls/wsgi), `manage.py` в корені.
- Продакшен-сервер: `gunicorn` (`config.wsgi:application`).

## Локальна розробка

```
uv sync                      # встановити залежності з uv.lock
uv run manage.py migrate
uv run manage.py runserver
```

Додавання залежностей: `uv add <package>` (прод) / `uv add --dev <package>` (dev-інструменти, лінтери, тести).

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

Dokku сам визначить buildpack за файлами проєкту (наприклад `package.json`) або використає `Dockerfile`/`Procfile`, якщо вони є в корені репозиторію. На момент написання цього файлу застосунок ще не має коду — перший `git push dokku main` вимагатиме валідного buildpack/Dockerfile.

## Корисні команди адміністрування (через proxmox)

```
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku apps:list'"
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku logs mahjong -t'"
ssh proxmox "sudo pct exec 101 -- bash -c 'dokku config:show mahjong'"
```
