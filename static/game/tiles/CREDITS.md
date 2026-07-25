# Tile artwork credits

The oblique mahjong tile graphics in this directory (`Man*.svg`, `Pin*.svg`,
`Sou*.svg`, the four winds, three dragons, four flowers and four seasons) are
derived from the **"SVG Oblique illustrations of Mahjong tiles"** set by
Wikimedia Commons user **Cangjie6**.

- Source: https://commons.wikimedia.org/wiki/Category:SVG_Oblique_illustrations_of_Mahjong_tiles
- Author: Cangjie6 (https://commons.wikimedia.org/wiki/User:Cangjie6)
- License: **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**
  — https://creativecommons.org/licenses/by-sa/4.0/

The files were renamed to this game's tile-kind keys (e.g. `MJw1-.svg` → `Man1.svg`,
`MJh5-.svg` → `Plum.svg`) and stripped of Adobe Illustrator editor metadata
(the external `<!DOCTYPE>`/DTD, entity declarations, and `<switch>`/`<foreignObject>`
blocks — the latter tainted the WebGL canvas, blocking runtime rasterization); the
visible artwork (paths/colors) is unchanged. As a CC BY-SA work, these tile assets
and any derivatives of them remain under CC BY-SA 4.0.

> Filename mapping: characters 萬 `MJw1-9` → `Man1-9`; dots 筒 `MJt1-9` → `Pin1-9`;
> bamboo 索 `MJs1-9` → `Sou1-9`; winds `MJf1-4` (東南西北) → `Ton/Nan/Shaa/Pei`;
> dragons `MJd1-3` (中發白) → `Chun/Hatsu/Haku`; seasons `MJh1-4` (春夏秋冬) →
> `Spring/Summer/Autumn/Winter`; flowers `MJh5-8` (梅蘭菊竹) →
> `Plum/Orchid/Chrysanthemum/Bamboo`.

The older `*.png` tiles and `Front.png` in this directory are the previous
CC0 riichi set by [FluffyStuff](https://github.com/FluffyStuff/riichi-mahjong-tiles),
kept only as a source for icon generation (`scripts/gen_icons.py`).
