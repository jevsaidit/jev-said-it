# DEGEN banner 1500x500: 150x50 grid, 10px pixels. Rays, pumping candles, coins, meme.
from PIL import Image, ImageDraw, ImageFont
import math, random, importlib.util, sys
sys.argv = ["x"]; spec = importlib.util.spec_from_file_location("d", "degen.py"); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)

W, H, SC = 150, 50, 10
BG1, BG2 = (9, 26, 15), (14, 40, 23)
GREEN, GOLD, GOLD2, INK, WHITE, RED = (61, 240, 122), (255, 206, 40), (206, 150, 20), (10, 14, 12), (250, 252, 240), (255, 60, 60)
img = Image.new("RGB", (W, H), BG1)
cx, cy = 131, 30                                  # center of the rays: the mascot's head
for y in range(H):
    for x in range(W):
        a = math.degrees(math.atan2(y - cy, x - cx)) % 360
        if int(a // 12) % 2 == 0: img.putpixel((x, y), BG2)
dr = ImageDraw.Draw(img)
# pumping candles, bottom-left to top-right (behind everything else)
random.seed(4); p = 44
for x in range(40, 108, 4):
    o = p; p = max(6, p - random.randint(-1, 4)); c = p
    hi, lo = min(o, c) - random.randint(1, 3), max(o, c) + random.randint(1, 2)
    col = GREEN if c <= o else RED
    dr.line([(x + 1, hi), (x + 1, lo)], fill=col); dr.rectangle([x, min(o, c), x + 2, max(o, c)], fill=col)
# raining coins
random.seed(9)
for _ in range(14):
    x, y = random.randint(34, 112), random.randint(1, 24)
    dr.rectangle((x, y, x + 2, y + 2), fill=GOLD); img.putpixel((x + 2, y + 2), GOLD2); img.putpixel((x, y), (255, 240, 160))

def pw(s, size, w=700):
    f = ImageFont.truetype("PixelifySans.ttf", size); f.set_variation_by_axes([w]); b = f.getbbox(s); return b[2] - b[0], b[3]

def ptext(xy, s, size, fill, shadow=None, w=700):
    f = ImageFont.truetype("PixelifySans.ttf", size); f.set_variation_by_axes([w])
    for off, col in ([(1, 1)], [shadow])[0:0] or ([((1, 1), shadow)] if shadow else []):
        pass
    if shadow:
        lay = Image.new("L", (W, H), 0); ld = ImageDraw.Draw(lay); ld.fontmode = "1"; ld.text((xy[0] + 1, xy[1] + 1), s, font=f, fill=255)
        img.paste(Image.new("RGB", (W, H), shadow), (0, 0), lay)
    lay = Image.new("L", (W, H), 0); ld = ImageDraw.Draw(lay); ld.fontmode = "1"; ld.text(xy, s, font=f, fill=255)
    img.paste(Image.new("RGB", (W, H), fill), (0, 0), lay)
    return ld.textbbox(xy, s, font=f)

ptext((4, 1), "JEV SAID", 16, WHITE, INK)
dr.rectangle((5, 20, 30, 35), fill=INK); dr.rectangle((4, 19, 29, 34), fill=GOLD)
ptext((6, 18), "IT.", 16, INK)
# ticker plate, as wide as the text
tw, th = pw("$JEVSAIDIT", 11)
dr.rectangle((34, 23, 34 + tw + 5, 36), fill=INK); dr.rectangle((33, 22, 33 + tw + 4, 35), fill=GREEN)
ptext((35, 21), "$JEVSAIDIT", 11, INK)
# laser mascot, big, bottom right (the lasers leave the edge)
m = d.render(1, bg=False).convert("RGBA")
img.paste(m, (W - 40 - 1, H - 38), m)
# speech bubble, as wide as the line
tw, th = pw("SO I APED.", 10)
bx0, by0 = 84, 2; bx1, by1 = bx0 + tw + 6, 13
dr.rectangle((bx0 + 1, by0 + 1, bx1 + 1, by1 + 1), fill=INK); dr.rectangle((bx0, by0, bx1, by1), fill=WHITE)
dr.polygon([(bx1 - 9, by1), (bx1 - 4, by1), (bx1 + 1, by1 + 5)], fill=WHITE)
ptext((bx0 + 3, by0), "SO I APED.", 10, INK)
big = img.resize((W * SC, H * SC), Image.NEAREST); big.save("degen-banner-1500x500.png")
cv = Image.new("RGB", (1500, 640), (0, 0, 0)); cv.paste(big, (0, 0))
av = Image.open("degen-pfp-400.png").resize((134, 134), Image.NEAREST)
mk = Image.new("L", (134, 134), 0); ImageDraw.Draw(mk).ellipse((0, 0, 133, 133), fill=255)
rg = Image.new("L", (142, 142), 0); ImageDraw.Draw(rg).ellipse((0, 0, 141, 141), fill=255)
cv.paste(Image.new("RGB", (142, 142), (0, 0, 0)), (16, 426), rg); cv.paste(av, (20, 430), mk); cv.save("degen-banner-preview.png"); print("ok")
