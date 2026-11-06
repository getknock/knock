"""The Human Club's logo, exported for anything off the club's pages.

`logo.py` draws the identity: an H that is a door knocker, its brass ring hung behind the crossbar, on the club's
bottle-green door, and the name in Big Shoulders 900 as outlines. This script takes that identity and writes the files
a listing, a press kit or an app icon needs, without asking for the fonts again:

    python3 brand/exports.py

Writes into brand/ and public/:

- human-club-icon.svg / .png (1024, dark; full-bleed, since platforms round their own icons)
- human-club-icon-light.svg / .png (1024, for light surfaces)
- human-club-wordmark.svg / .png (transparent, paper on dark)
- human-club-wordmark-dark.svg / .png (door green on light)
- public/logo.png (the sign at 2x, transparent-free, for a README or a listing)

Rendering takes Inkscape.
"""

import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).parent
PUBLIC = HERE.parent / 'public'

# The club's colors (app/globals.css)
DOOR, PAPER, BRASS, BRASS_DEEP = '#12382c', '#fbfaf5', '#d4a72c', '#8a6a12'

# The knocker on a 64 grid (logo.py)
STEM, COUNTER, TOP, BOTTOM, BAR_TOP, BAR_BOTTOM = 8, 20, 8, 56, 17.5, 25
RING_OUT, RING_IN, RING_Y = 8, 5, 29.5


def knocker(x, y, s, stems, shade=True):
    u = s / 64
    left = 32 - COUNTER / 2 - STEM

    def rect(a, b, w, h, fill):
        return f'<rect x="{x + a * u:.2f}" y="{y + b * u:.2f}" width="{w * u:.2f}" height="{h * u:.2f}" fill="{fill}"/>'

    def circle(r):
        return (
            f'M{x + (32 - r) * u:.2f} {y + RING_Y * u:.2f}a{r * u:.2f} {r * u:.2f} 0 1 0 {2 * r * u:.2f} 0'
            f'a{r * u:.2f} {r * u:.2f} 0 1 0 {-2 * r * u:.2f} 0z'
        )

    ring = circle(RING_OUT) + circle(RING_IN)
    out = f'<path fill="{BRASS}" fill-rule="evenodd" d="{ring}"/>'
    if shade:
        out += (
            f'<clipPath id="ring"><path fill-rule="evenodd" d="{ring}"/></clipPath>'
            f'<g clip-path="url(#ring)">{rect(32 - RING_OUT, BAR_BOTTOM, 2 * RING_OUT, 1.6, BRASS_DEEP)}</g>'
        )
    return (
        out
        + rect(left, TOP, STEM, BOTTOM - TOP, stems)
        + rect(32 + COUNTER / 2, TOP, STEM, BOTTOM - TOP, stems)
        + rect(left + STEM, BAR_TOP, COUNTER, BAR_BOTTOM - BAR_TOP, stems)
    )


def svg(w, h, body, title='The Human Club'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><title>{title}</title>{body}</svg>\n'


def wordmark():
    """The name's outlines, lifted from the sign public/logo.svg, cropped to the letters"""
    sign = (PUBLIC / 'logo.svg').read_text()
    letters = re.search(r'<path fill="#fbfaf5" transform="translate\(72 60\)" d="([^"]+)"/>', sign)
    if not letters:
        raise SystemExit('public/logo.svg has no wordmark to lift; run brand/logo.py first')
    # The sign draws the letters at (72, 60), their baseline; lift them to the top-left of a 329x40 box
    return f'<path transform="translate(0 40)" d="{letters.group(1)}"/>', 329, 40


def png(source, name, w, h):
    subprocess.run(
        ['inkscape', str(source), '--export-type=png', f'--export-filename={HERE / name}',
         f'--export-width={w}', f'--export-height={h}'],
        check=True,
        capture_output=True,
    )


def main():
    def write(directory, name, content):
        path = directory / name
        path.write_text(content)
        return path

    # The app icon: full-bleed, no rounding, since a platform masks its own
    dark = write(HERE, 'human-club-icon.svg', svg(512, 512, f'<rect width="512" height="512" fill="{DOOR}"/>{knocker(36, 36, 440, PAPER)}'))
    light = write(HERE, 'human-club-icon-light.svg', svg(512, 512, f'<rect width="512" height="512" fill="{PAPER}"/>{knocker(36, 36, 440, DOOR)}'))
    for src, name in ((dark, 'human-club-icon.png'), (light, 'human-club-icon-light.png')):
        png(src, name, 1024, 1024)

    # The wordmark on its own, transparent, for a dark or a light surface
    letters, w, h = wordmark()
    mark_dark = write(HERE, 'human-club-wordmark.svg', svg(w, h, f'<g fill="{PAPER}">{letters}</g>'))
    mark_light = write(HERE, 'human-club-wordmark-dark.svg', svg(w, h, f'<g fill="{DOOR}">{letters}</g>'))
    png(mark_dark, 'human-club-wordmark.png', w * 3, h * 3)
    png(mark_light, 'human-club-wordmark-dark.png', w * 3, h * 3)

    # The sign, at twice its size, for a README or a listing page
    png(PUBLIC / 'logo.svg', 'logo.png', 842, 160)
    (HERE / 'logo.png').replace(PUBLIC / 'logo.png')


if __name__ == '__main__':
    main()
