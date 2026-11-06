# The Human Club's logo

An H that is a door knocker: its brass ring hangs behind the crossbar and comes out from under it into the H's tall
lower counter, on the club's bottle-green door. The name is set in Big Shoulders 900.

`logo.py` draws the identity from the two fonts and writes the site's byproducts (favicon, home-screen icon, link
preview, the sign). `exports.py` turns that identity into the files a listing or a press kit needs, lifting the
wordmark's outlines from `public/logo.svg` so it needs no fonts:

| File | Use |
|---|---|
| `human-club-icon.svg` / `.png` (1024) | App icon, dark. Full-bleed: platforms round their own. |
| `human-club-icon-light.svg` / `.png` (1024) | App icon on a light surface. |
| `human-club-wordmark.svg` / `.png` (987x120) | The name alone, paper, transparent: for a dark surface. |
| `human-club-wordmark-dark.svg` / `.png` (987x120) | The name alone, door green, transparent: for a light surface. |
| `../public/logo.svg` / `logo.png` | The sign: mark and name on a board of the door, 842x160. |

Colours: door `#12382c`, paper `#fbfaf5`, brass `#d4a72c`, brass deep `#8a6a12`.

```bash
python3 brand/exports.py   # needs Inkscape; writes brand/ and public/logo.png
```
