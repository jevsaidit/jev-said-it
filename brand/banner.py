# X banner 1500x500. Real pixels (x5 grid) for background, title and frames; mascot x10;
# the receipt's small text at high resolution in Martian Mono, as the site does.
from PIL import Image, ImageDraw, ImageFont
import random, importlib.util, sys
spec = importlib.util.spec_from_file_location("m", "mascot.py"); sys.argv = ["x", "."]
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

W, H, SC = 300, 100, 5
BG, GRID, DIM, DIM2 = (7, 18, 11), (14, 42, 23), (18, 56, 32), (26, 82, 46)
GREEN, GOLD, INK, PAPER = (61, 240, 122), (242, 194, 48), (7, 18, 11), (240, 244, 226)
STAMP, MUTED = (20, 150, 70), (95, 108, 98)
g = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(g)
for y in range(2, H, 6):
    for x in range(2, W, 6): g.putpixel((x, y), GRID)
# candles: rising behind the receipt, faint
random.seed(11); price = 82
for x in range(92, 196, 5):
    o = price; price = max(24, price - random.randint(-3, 7)); c = price
    hi, lo = min(o, c) - random.randint(1, 4), max(o, c) + random.randint(1, 4)
    col = DIM2 if c < o else DIM
    d.line([(x + 1, hi), (x + 1, lo)], fill=col); d.rectangle([x, min(o, c), x + 2, max(o, c)], fill=col)

def pwidth(s, size, w=700):
    f = ImageFont.truetype("PixelifySans.ttf", size); f.set_variation_by_axes([w])
    b = f.getbbox(s); return b[2] - b[0]

def ptext(img, xy, s, size, fill, w=700):
    f = ImageFont.truetype("PixelifySans.ttf", size); f.set_variation_by_axes([w])
    layer = Image.new("L", img.size, 0); ld = ImageDraw.Draw(layer); ld.fontmode = "1"
    ld.text(xy, s, font=f, fill=255); img.paste(Image.new("RGB", img.size, fill), (0, 0), layer)

ptext(g, (14, 5), "JEV", 27, GREEN); ptext(g, (14, 30), "SAID", 27, GREEN)
bx = (14, 57, 45, 81); d.rectangle((bx[0] + 2, bx[1] + 2, bx[2] + 2, bx[3] + 2), fill=(110, 82, 8)); d.rectangle(bx, fill=GOLD)
ptext(g, (17, 55), "IT.", 27, INK)
# receipt (pixel shape)
rx0, ry0, rx1, ry1 = 104, 12, 172, 88
d.rectangle((rx0 + 2, ry0 + 2, rx1 + 2, ry1 + 2), fill=(3, 8, 5))
d.rectangle((rx0, ry0, rx1, ry1), fill=PAPER)
for x in range(rx0, rx1, 4):
    d.polygon([(x, ry0), (x + 2, ry0 - 2), (x + 4, ry0)], fill=PAPER); d.polygon([(x, ry1), (x + 2, ry1 + 2), (x + 4, ry1)], fill=PAPER)
for x in range(rx0 + 4, rx1 - 3, 2): g.putpixel((x, ry0 + 16), (170, 178, 168))
ptext(g, ((rx0 + rx1) // 2 - pwidth("JEV SAID IT", 10) // 2, ry0 + 3), "JEV SAID IT", 10, INK)
# MATCH stamp (pixels)
sx, sy = rx0 + 18, ry0 + 60
d.rectangle((sx, sy, sx + 36, sy + 12), outline=STAMP); d.rectangle((sx + 1, sy + 1, sx + 35, sy + 11), outline=STAMP)
# speech bubble (pixels)
bx0, by0, bx1, by1 = 178, 5, 178 + pwidth("JEV SAID IT.", 12) + 11, 22
d.rectangle((bx0 + 2, by0 + 2, bx1 + 2, by1 + 2), fill=(3, 8, 5)); d.rectangle((bx0, by0, bx1, by1), fill=PAPER)
d.polygon([(236, by1), (244, by1), (252, by1 + 7)], fill=PAPER)
ptext(g, (bx0 + 5, by0 + 2), "JEV SAID IT.", 12, INK)

big = g.resize((W * SC, H * SC), Image.NEAREST)
# mascot x10, resting on the bottom edge, on the right
sprite = m.render(8, bg=False).convert("RGBA")
big.paste(sprite, (1500 - 400 - 40, 100), sprite)
# receipt's small text, high resolution
D = ImageDraw.Draw(big)
def mono(xy, s, size, fill, w=500):
    f = ImageFont.truetype("MartianMono.ttf", size)
    try: f.set_variation_by_axes([100, w])
    except Exception: pass
    D.text(xy, s, font=f, fill=fill)
X0, Y0 = rx0 * SC + 22, ry0 * SC + 98
rows = [("question", "up in 6h?"), ("token", "0x0000…1d17"), ("calls close", "19:35 UTC"), ("model", "jev")]
for i, (k, v) in enumerate(rows):
    mono((X0, Y0 + i * 30), k, 17, MUTED, 400); mono((X0 + 150, Y0 + i * 30), v, 17, INK, 500)
mono((X0, Y0 + 4 * 30 + 2), "p (up)", 17, MUTED, 400)
D.rectangle((X0 + 146, Y0 + 4 * 30 - 4, X0 + 250, Y0 + 4 * 30 + 26), outline=INK, width=3); mono((X0 + 156, Y0 + 4 * 30), "0.6412", 17, INK, 700)
mono((X0, Y0 + 5 * 30 + 14), "id = keccak256(receipt)", 14, MUTED, 400)
f = ImageFont.truetype("MartianMono.ttf", 26); f.set_variation_by_axes([800, 112])
tb = D.textbbox((0, 0), "MATCH", font=f)
D.text(((sx + 18) * SC - (tb[2] - tb[0]) // 2 + 2, (sy + 6) * SC - (tb[3] + tb[1]) // 2 + 2), "MATCH", font=f, fill=STAMP)
# line under the title
mono((260, 452), "$JEVSAIDIT · Robinhood Chain", 20, GREEN, 500)
big.save("banner-1500x500.png")
# Open Graph 1200x630: same scene, background extended above and below, no overlaid avatar
og = Image.new("RGB", (1200, 630), BG); od = ImageDraw.Draw(og)
for y in range(10, 630, 30):
    for x in range(10, 1200, 30): od.rectangle((x, y, x + 4, y + 4), fill=GRID)
og.paste(big.resize((1200, 400), Image.NEAREST), (0, 90))
og.save("og-1200x630.png")

# preview as on X desktop: round avatar overlaid bottom left
canvas = Image.new("RGB", (1500, 640), (0, 0, 0)); canvas.paste(big, (0, 0))
av = Image.open("pfp-400.png").resize((134, 134), Image.NEAREST)
mask = Image.new("L", (134, 134), 0); ImageDraw.Draw(mask).ellipse((0, 0, 133, 133), fill=255)
ring = Image.new("L", (142, 142), 0); ImageDraw.Draw(ring).ellipse((0, 0, 141, 141), fill=255)
canvas.paste(Image.new("RGB", (142, 142), (0, 0, 0)), (16, 426), ring); canvas.paste(av, (20, 430), mask)
canvas.save("banner-preview.png"); print("ok")
