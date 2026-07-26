"""Board shapes ("layouts") loaded from the kmahjongg native `.layout`
ASCII-grid format (project root `layouts/*.layout`) — see KDE kmahjongg
(invent.kde.org/games/kmahjongg, GPL), `src/boardlayout.cpp:
loadBoardLayout`/`initialiseBoard`, whose parsing rules this module mirrors:
header `kmahjongg-layout-v1.0`/`v1.1`, `w`/`h`/`d` size lines, then `d` grid
blocks of `h` rows × `w` characters. A tile occupies a 2×2 block of grid
characters marked `1`(top-left, the anchor and the one that counts as "one
tile") `2`(top-right) `3`(bottom-right) `4`(bottom-left); `.` is empty. Grid
rows are read in `x` (left→right) then `y` (top→bottom) then `z` (block
index, block 0 = bottom layer) order — same as kmahjongg.

Only 144-tile ('1' count) layouts are accepted — the project's deck is a
fixed 72 pairs (see gameplay/generator.py), so every board must have exactly
144 target positions.
"""
import re
from functools import lru_cache
from pathlib import Path

from django.utils.translation import gettext, gettext_noop
from ninja import Schema

from config.settings import BASE_DIR

LAYOUTS_DIR = BASE_DIR / 'layouts'

_MAGIC_V11 = 'kmahjongg-layout-v1.1'
_MAGIC_V10 = 'kmahjongg-layout-v1.0'

_ANCHOR = '1'
# The anchor's own quadrant ('1', at (0,0)) is excluded — only the other
# three quadrants of a tile's 2×2 footprint need verifying against the grid.
_OTHER_QUADRANTS = {'2': (1, 0), '3': (1, 1), '4': (0, 1)}

_TOTAL_TILES = 144

# Board names come from `.layout` file comments (English, see parse_layout
# below) and are cached process-wide by load_layouts() — so they can't carry
# a translation baked in (that would freeze them at whichever language
# happened to trigger the first parse). Registering the known names here only
# makes makemessages pick them up as msgids; list_boards() does the actual
# per-request gettext() lookup.
gettext_noop('Turtle')
gettext_noop('Dragon')
gettext_noop('Cat')


class Layout(Schema):
    """One board shape: `positions` are 144 (x, y, z) target cells on the
    half-tile grid (gameplay/board.py: is_free_position/match_key operate on
    exactly this coordinate system, board-shape-agnostic)."""

    slug: str
    name: str
    width: int
    height: int
    layers: int
    positions: list[tuple[int, int, int]]


class LayoutError(ValueError):
    """A `.layout` file is malformed or doesn't describe a 144-tile board."""


def parse_layout(text, slug):
    lines = text.splitlines()
    if not lines:
        raise LayoutError(f'{slug}: empty file')

    magic = lines[0].strip()
    if magic not in (_MAGIC_V11, _MAGIC_V10):
        raise LayoutError(f'{slug}: unknown header {magic!r}')

    name = slug
    width = height = depth = None
    grid_lines = []
    for line in lines[1:]:
        stripped = line.rstrip('\n')
        if stripped.startswith('#'):
            if name == slug:
                # The first comment line is the board's display name (the
                # curated files in layouts/ always lead with it — see e.g.
                # layouts/turtle.layout). kmahjongg itself keeps the name in
                # a sibling .desktop file instead; we fold it into the
                # comment for a single self-contained file.
                candidate = stripped.lstrip('#').strip()
                if candidate:
                    name = candidate
            continue
        if not stripped:
            continue
        if stripped[0] == 'w':
            width = int(stripped[1:])
        elif stripped[0] == 'h':
            height = int(stripped[1:])
        elif stripped[0] == 'd':
            depth = int(stripped[1:])
        elif re.fullmatch(r'[1234.]+', stripped):
            grid_lines.append(stripped)

    if width is None or height is None or depth is None:
        raise LayoutError(f'{slug}: missing w/h/d size line')
    expected_rows = height * depth
    if len(grid_lines) != expected_rows:
        raise LayoutError(f'{slug}: expected {expected_rows} grid rows, got {len(grid_lines)}')

    positions = []
    for z in range(depth):
        for y in range(height):
            row = grid_lines[z * height + y]
            if len(row) != width:
                raise LayoutError(f'{slug}: row {z * height + y} has length {len(row)}, expected {width}')
            for x, ch in enumerate(row):
                if ch != _ANCHOR:
                    continue
                # A tile's anchor is its '1' quadrant; verify the other three
                # quadrants (2/3/4) sit exactly where a 2×2 tile footprint
                # puts them, catching a corrupted/hand-edited grid.
                for quad_char, (dx, dy) in _OTHER_QUADRANTS.items():
                    qx, qy = x + dx, y + dy
                    if (
                        qx >= width or qy >= height
                        or grid_lines[z * height + qy][qx] != quad_char
                    ):
                        raise LayoutError(f'{slug}: tile at ({x},{y},{z}) missing quadrant {quad_char!r}')
                positions.append((x, y, z))

    if len(positions) != _TOTAL_TILES:
        raise LayoutError(f'{slug}: expected {_TOTAL_TILES} tiles, got {len(positions)}')
    if len(set(positions)) != len(positions):
        raise LayoutError(f'{slug}: duplicate tile position')

    # kmahjongg pads its grid with blank columns/rows around the shape (the
    # anchors' min x/y is rarely 0 — e.g. layouts/turtle.layout starts at
    # x=1). Normalize so the shape's own bounding box starts at (0, 0): a
    # uniform shift changes no *relative* distances, so is_free_position's
    # adjacency/coverage checks (gameplay/board.py — all relative, no
    # absolute-parity assumptions) are unaffected; only the client's
    # rendering origin cares about compactness.
    min_x = min(x for x, _y, _z in positions)
    min_y = min(y for _x, y, _z in positions)
    positions = [(x - min_x, y - min_y, z) for x, y, z in positions]

    # Recompute width/height as the shape's own bounding box (max coordinate
    # + 2, to fit the 2×2 footprint of the outermost tile) rather than
    # keeping the padded grid size — mirrors the old board.js/board.py
    # WIDTH/HEIGHT convention the client's computeLayout() relies on.
    width = max(x for x, _y, _z in positions) + 2
    height = max(y for _x, y, _z in positions) + 2

    return Layout(slug=slug, name=name, width=width, height=height, layers=depth, positions=positions)


@lru_cache(maxsize=1)
def load_layouts():
    """All boards in layouts/*.layout, parsed once per process (same
    once-per-process caching idea as whitenoise's manifest — see CLAUDE.md).
    Returns {slug: Layout}, sorted by slug for deterministic iteration."""
    layouts = {}
    for path in sorted(Path(LAYOUTS_DIR).glob('*.layout')):
        slug = path.stem
        layouts[slug] = parse_layout(path.read_text(encoding='utf-8'), slug)
    if not layouts:
        raise LayoutError(f'no .layout files found in {LAYOUTS_DIR}')
    return layouts


def get_layout(slug):
    return load_layouts().get(slug)


def list_boards():
    """[{'slug', 'name'}, ...] for the client's board-picker UI — config/urls.py
    passes this into templates/game.html's context, which renders it as
    `[data-board]` buttons (no separate JS global; main.js reads the
    attributes straight off the DOM, same as the difficulty buttons).
    gettext(layout.name) here (not baked into the cached Layout) — translates
    for the *current* request's active language; falls back to the English
    name itself if it isn't a registered msgid (see gettext_noop above)."""
    return [{'slug': layout.slug, 'name': gettext(layout.name)} for layout in load_layouts().values()]
