"""Генератор іконок (favicon + PWA/Apple) методом «крупного плану».

Композиція: кремова костяшка маджонга (Front.png) з червоним символом
中 — Червоний дракон (Chun.png) — по центру, на діагональному градієнті
глибокий синій → фіолетовий, з м'якою тінню під тайлом.

Запуск (Pillow не є проєктною залежністю, тягнеться ефемерно через uv):

    uv run --with pillow python scripts/gen_icons.py

Перегенерувати весь набір іконок можна в будь-який момент — джерела
(tiles/Front.png, tiles/Chun.png) уже лежать у репозиторії.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BASE_DIR = Path(__file__).resolve().parent.parent
TILES_DIR = BASE_DIR / "static" / "game" / "tiles"
OUT_DIR = BASE_DIR / "static" / "icons"

MASTER_SIZE = 1024

GRADIENT_START = (30, 58, 138)   # #1e3a8a — глибокий синій
GRADIENT_END = (109, 40, 217)    # #6d28d9 — фіолетовий

SHADOW_COLOR = (0, 0, 0)
SHADOW_OPACITY = 110
SHADOW_OFFSET_FRAC = 0.04
SHADOW_BLUR_FRAC = 0.03

TILE_FRAC_NORMAL = 0.72
TILE_FRAC_MASKABLE = 0.55
DRAGON_FRAC_OF_TILE = 0.62


def make_gradient_background(size: int) -> Image.Image:
    """Діагональний градієнт (лівий верх -> правий низ) з лёгкою віньєткою."""
    # Рахуємо градієнт по діагоналі: беремо проекцію кожного пікселя на
    # діагональ (0,0)-(size,size) і лінійно змішуємо кольори.
    base = Image.new("RGB", (size, size))
    px = base.load()
    diag = size * 2
    for y in range(size):
        for x in range(size):
            t = (x + y) / diag
            r = int(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * t)
            g = int(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * t)
            b = int(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * t)
            px[x, y] = (r, g, b)

    # Легка радіальна віньєтка для об'єму: темніші кути.
    vignette = Image.new("L", (size, size), 0)
    vdraw = ImageDraw.Draw(vignette)
    max_r = size * 0.75
    center = size / 2
    steps = 60
    for i in range(steps):
        t = i / steps
        radius = max_r * (1 - t)
        alpha = int(70 * t)
        vdraw.ellipse(
            [center - radius, center - radius, center + radius, center + radius],
            fill=alpha,
        )
    vignette = vignette.filter(ImageFilter.GaussianBlur(size * 0.08))
    dark_layer = Image.new("RGB", (size, size), (0, 0, 0))
    base = Image.composite(dark_layer, base, vignette)

    return base.convert("RGBA")


def load_rgba(name: str) -> Image.Image:
    return Image.open(TILES_DIR / name).convert("RGBA")


def render(size: int, tile_frac: float) -> Image.Image:
    canvas = make_gradient_background(size)

    front = load_rgba("Front.png")
    chun = load_rgba("Chun.png")

    tile_h = int(size * tile_frac)
    tile_w = int(tile_h * front.width / front.height)
    front_scaled = front.resize((tile_w, tile_h), Image.LANCZOS)

    tile_x = (size - tile_w) // 2
    tile_y = (size - tile_h) // 2

    # --- Тінь під тайлом: беремо альфа-маску тайла, зсуваємо й розмиваємо.
    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_shape = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
    shadow_alpha = front_scaled.split()[3].point(lambda a: SHADOW_OPACITY if a > 0 else 0)
    shadow_shape.putalpha(shadow_alpha)
    shadow_fill = Image.new("RGBA", (tile_w, tile_h), (*SHADOW_COLOR, 0))
    shadow_fill.putalpha(shadow_alpha)
    offset = int(size * SHADOW_OFFSET_FRAC)
    shadow_layer.alpha_composite(shadow_fill, (tile_x, tile_y + offset))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(size * SHADOW_BLUR_FRAC))
    canvas.alpha_composite(shadow_layer)

    # --- Тайл (кремове лице костяшки).
    canvas.alpha_composite(front_scaled, (tile_x, tile_y))

    # --- Дракон 中 по центру тайла.
    dragon_h = int(tile_h * DRAGON_FRAC_OF_TILE)
    dragon_w = int(dragon_h * chun.width / chun.height)
    chun_scaled = chun.resize((dragon_w, dragon_h), Image.LANCZOS)
    dragon_x = tile_x + (tile_w - dragon_w) // 2
    dragon_y = tile_y + (tile_h - dragon_h) // 2
    canvas.alpha_composite(chun_scaled, (dragon_x, dragon_y))

    return canvas


def downscale(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    master_normal = render(MASTER_SIZE, TILE_FRAC_NORMAL)
    master_maskable = render(MASTER_SIZE, TILE_FRAC_MASKABLE)

    # PWA / Android icons (з прозорим фоном за межами градієнта немає —
    # фон повністю заповнений градієнтом).
    downscale(master_normal, 512).save(OUT_DIR / "icon-512.png")
    downscale(master_normal, 192).save(OUT_DIR / "icon-192.png")
    downscale(master_maskable, 512).save(OUT_DIR / "icon-maskable-512.png")
    downscale(master_maskable, 192).save(OUT_DIR / "icon-maskable-192.png")

    # Apple touch icon — без альфи (iOS сам заокруглює кути).
    apple = downscale(master_normal, 180).convert("RGB")
    apple.save(OUT_DIR / "apple-touch-icon.png")

    # Favicon PNG (32) + multi-res .ico (16/32/48).
    favicon_32 = downscale(master_normal, 32)
    favicon_32.save(OUT_DIR / "favicon-32.png")

    favicon_sizes = [16, 32, 48]
    favicon_images = [downscale(master_normal, s) for s in favicon_sizes]
    favicon_images[0].save(
        OUT_DIR / "favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in favicon_sizes],
        append_images=favicon_images[1:],
    )

    print(f"Готово: іконки записано в {OUT_DIR}")


if __name__ == "__main__":
    main()
