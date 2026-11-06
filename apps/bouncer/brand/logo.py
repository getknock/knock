"""The Human Club's logo, drawn: an H that is a door knocker, its brass ring hung behind the crossbar, on the club's
bottle-green door, and the name in Big Shoulders 900 as outlines, so nothing needs the font.

Writes the favicon (icon.svg, favicon.ico), the home-screen icon (apple-icon.png), the link preview
(opengraph-image.png) and the sign (logo.svg). The club serves the first four from app/ and the sign from public/.

    uv run --with fonttools --with brotli --with uharfbuzz python3 brand/logo.py \\
        <Big Shoulders .woff2 or .ttf> <Instrument Sans .woff2 or .ttf> <out dir>

Both fonts are variable, and under the SIL Open Font License; `next build` leaves their Latin files in
.next/static/media. Rendering takes Inkscape and ImageMagick.
"""

import io
import pathlib
import subprocess
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# The club's colors (app/globals.css)
DOOR, PAPER, BRASS, BRASS_DEEP = '#12382c', '#fbfaf5', '#d4a72c', '#8a6a12'

# The knocker on a 64 grid: stems 8 wide, a counter 20 wide, the crossbar high, and the ring, 16 across, hung behind
# it, so it comes out from under the bar into the H's tall lower counter
STEM, COUNTER, TOP, BOTTOM, BAR_TOP, BAR_BOTTOM = 8, 20, 8, 56, 17.5, 25
RING_OUT, RING_IN, RING_Y = 8, 5, 29.5


class Face:
    """A variable font at one weight, shaped with HarfBuzz and drawn as SVG paths"""

    def __init__(self, path, wght):
        f = instantiateVariableFont(TTFont(path), {'wght': wght}, inplace=False)
        f.flavor = None
        buf = io.BytesIO()
        f.save(buf)
        self.hb = hb.Font(hb.Face(buf.getvalue()))
        self.upem = f['head'].unitsPerEm
        self.cap = f['OS/2'].sCapHeight
        self.glyphs = f.getGlyphSet()
        self.order = f.getGlyphOrder()

    def path(self, text, size):
        """The text's outlines, its baseline at 0, and its width"""
        b = hb.Buffer()
        b.add_str(text)
        b.guess_segment_properties()
        hb.shape(self.hb, b, {'kern': True, 'liga': True})
        k = size / self.upem
        x, out = 0, []
        for info, pos in zip(b.glyph_infos, b.glyph_positions):
            pen = SVGPathPen(self.glyphs)
            glyph = self.glyphs[self.order[info.codepoint]]
            glyph.draw(TransformPen(pen, (k, 0, 0, -k, (x + pos.x_offset) * k, -pos.y_offset * k)))
            out.append(pen.getCommands())
            x += pos.x_advance
        return ' '.join(out), x * k

    def size_for_cap(self, cap):
        return cap * self.upem / self.cap


def knocker(x, y, s, shade=True):
    """The mark in a box s across at (x, y). With shade, the bar's shadow falls across the top of the ring: under a
    pixel below 64 px, so the small sizes go without it."""
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
            f'<clipPath id="ring{s}"><path fill-rule="evenodd" d="{ring}"/></clipPath>'
            f'<g clip-path="url(#ring{s})">{rect(32 - RING_OUT, BAR_BOTTOM, 2 * RING_OUT, 1.6, BRASS_DEEP)}</g>'
        )
    return (
        out
        + rect(left, TOP, STEM, BOTTOM - TOP, PAPER)
        + rect(32 + COUNTER / 2, TOP, STEM, BOTTOM - TOP, PAPER)
        + rect(left + STEM, BAR_TOP, COUNTER, BAR_BOTTOM - BAR_TOP, PAPER)
    )


def svg(w, h, body, title='The Human Club'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><title>{title}</title>{body}</svg>\n'


def main():
    sign_font, text_font, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    sign, text = Face(sign_font, 900), Face(text_font, 500)

    def write(name, content):
        (out / name).write_text(content)
        return out / name

    def png(src, name, w, h):
        subprocess.run(
            ['inkscape', str(src), '--export-type=png', f'--export-filename={out / name}', f'--export-width={w}', f'--export-height={h}'],
            check=True,
            capture_output=True,
        )
        return out / name

    # The favicon: a square of the door with the knocker on it
    icon = write('icon.svg', svg(64, 64, f'<rect width="64" height="64" rx="14" fill="{DOOR}"/>{knocker(0, 0, 64, shade=False)}'))
    small = [png(icon, f'icon-{n}.png', n, n) for n in (16, 32, 48)]
    subprocess.run(['magick', *small, str(out / 'favicon.ico')], check=True)
    for f in small:
        f.unlink()

    # The home-screen icon: square, since phones round it themselves
    apple = write('apple-icon.svg', svg(180, 180, f'<rect width="180" height="180" fill="{DOOR}"/>{knocker(12, 12, 156)}'))
    png(apple, 'apple-icon.png', 180, 180)
    apple.unlink()

    # The sign: the knocker and the name on a board of the door, for anywhere off the club's own pages
    name, name_w = sign.path('The Human Club', sign.size_for_cap(40))
    pad = 20
    w = round(pad + 36 + 16 + name_w + pad)
    write(
        'logo.svg',
        svg(
            w,
            80,
            f'<rect width="{w}" height="80" rx="12" fill="{DOOR}"/>{knocker(pad - 14, 8, 64, shade=False)}'
            f'<path fill="{PAPER}" transform="translate({pad + 36 + 16} 60)" d="{name}"/>',
        ),
    )

    # The link preview: the knocker on the door, the name, and what the club is for
    W, H, s = 1200, 630, 360
    size = sign.size_for_cap(118)
    line1, _ = sign.path('The Human', size)
    line2, _ = sign.path('Club', size)
    say = ['Petitions only humans can sign, and', 'fundraisers only humans can start.']
    said = ''.join(f'<path fill="{PAPER}" fill-opacity="0.82" transform="translate(0 {i * 48})" d="{text.path(t, 34)[0]}"/>' for i, t in enumerate(say))
    og = write(
        'opengraph-image.svg',
        svg(
            W,
            H,
            f'<rect width="{W}" height="{H}" fill="{DOOR}"/>{knocker(70, (H - s) / 2, s)}'
            f'<path fill="{PAPER}" transform="translate(470 218)" d="{line1}"/>'
            f'<path fill="{PAPER}" transform="translate(470 366)" d="{line2}"/>'
            f'<g transform="translate(474 448)">{said}</g>',
        ),
    )
    png(og, 'opengraph-image.png', W, H)
    og.unlink()


if __name__ == '__main__':
    main()
