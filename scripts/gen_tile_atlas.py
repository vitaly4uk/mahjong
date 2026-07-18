"""Генератор текстурного атласу кісток для Phaser (this.load.atlas).

Пакує 35 тайлів (Front + 34 автентичних riichi-види, static/game/tiles/*.png,
кожен 600x800) в один downscaled WebP-атлас + JSON координат (Phaser JSON
Hash), щоб клієнт вантажив одну текстуру одним запитом замість 35 окремих
image-запитів.

Downscale до TARGET_H (за замовчуванням 320px по довшій стороні): гра
рендерить канвас із zoom = devicePixelRatio (static/game/main.js, створення
Phaser.Game), тож грань кістки в backing-buffer займає щонайбільше
FACE_H * devicePixelRatio пікселів (FACE_H = 87, render-constants.js) —
87*2=174 (DPR=2, retina), 87*3=261 (DPR=3). Вище цієї межі різкість обмежує
сам буфер Phaser (як і в рантайм-текстурі корпусу tileBody чи в тексті), не
текстура. TARGET_H=320 перекриває DPR до ~3.7 із запасом.

Запуск (Pillow не є проєктною залежністю, тягнеться ефемерно через uv):

    uv run --with pillow python scripts/gen_tile_atlas.py

Джерела (static/game/tiles/*.png) лишаються в репозиторії — атлас можна
перегенерувати в будь-який момент, наприклад підвищивши TARGET_H.
"""

import json
from pathlib import Path

from PIL import Image

BASE_DIR = Path(__file__).resolve().parent.parent
TILES_DIR = BASE_DIR / "static" / "game" / "tiles"
OUT_DIR = BASE_DIR / "static" / "game"

# Автентичні riichi-види (те саме, що KINDS у static/game/board.js) + Front —
# лицьова "заглушка" кістки, під яку лягає вид.
KINDS = [
    f"{suit}{i}" for suit in ("Man", "Pin", "Sou") for i in range(1, 10)
] + ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"]
FRAMES = ["Front", *KINDS]

TARGET_H = 320  # цільова висота фрейму в атласі, px (див. docstring)
PADDING = 2  # px між фреймами — запобігає bleeding при білінійній фільтрації
GRID_COLS = 6  # 6x6 = 36 слотів, вистачає на 35 фреймів


def load_scaled(name: str) -> Image.Image:
    img = Image.open(TILES_DIR / f"{name}.png").convert("RGBA")
    w = round(img.width * TARGET_H / img.height)
    return img.resize((w, TARGET_H), Image.LANCZOS)


def main() -> None:
    scaled = {name: load_scaled(name) for name in FRAMES}

    cell_w = max(img.width for img in scaled.values()) + PADDING
    cell_h = max(img.height for img in scaled.values()) + PADDING
    rows = -(-len(FRAMES) // GRID_COLS)  # ceil

    atlas_w = cell_w * GRID_COLS
    atlas_h = cell_h * rows
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))

    frames = {}
    for i, name in enumerate(FRAMES):
        col, row = i % GRID_COLS, i // GRID_COLS
        img = scaled[name]
        x, y = col * cell_w, row * cell_h
        atlas.paste(img, (x, y))
        frames[name] = {
            "frame": {"x": x, "y": y, "w": img.width, "h": img.height},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": img.width, "h": img.height},
            "sourceSize": {"w": img.width, "h": img.height},
        }

    webp_path = OUT_DIR / "tiles.webp"
    # lossless виявився менший і чіткіший за lossy (навіть quality=90) на цій
    # пласкій лінійній графіці з альфою — жодних артефактів на тексті/краях.
    atlas.save(webp_path, "WEBP", lossless=True)

    json_path = OUT_DIR / "tiles.json"
    manifest = {
        "frames": frames,
        "meta": {
            "app": "scripts/gen_tile_atlas.py",
            "image": "tiles.webp",
            "size": {"w": atlas_w, "h": atlas_h},
            "scale": 1,
        },
    }
    json_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    print(
        f"Готово: {webp_path} ({webp_path.stat().st_size // 1024} KB), "
        f"{len(frames)} фреймів, {atlas_w}x{atlas_h}"
    )


if __name__ == "__main__":
    main()
