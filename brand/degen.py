# DEGEN mascot: 40x40 grid (big pixels, memecoin style), laser eyes, grin, sunburst background.
from PIL import Image, ImageDraw
import math, sys

N = 40
P = {
    "G": (61, 240, 122), "g": (120, 250, 160),            # background green + light rays
    "K": (10, 14, 12),                                    # outline
    "C": (22, 22, 26), "c": (58, 60, 66),                 # cap
    "F": (250, 170, 150), "f": (220, 128, 112), "h": (255, 205, 185),  # skin
    "Y": (255, 206, 40), "y": (206, 150, 20),             # gold / blond
    "S": (8, 8, 10), "W": (255, 255, 255),                # sunglasses, white
    "M": (120, 20, 30), "T": (255, 250, 240), "t": (255, 110, 120),     # mouth, teeth, tongue
    "B": (18, 40, 26), "b": (34, 72, 46),                 # hoodie
    "R": (255, 40, 40), "r": (255, 140, 60), "L": (255, 250, 200),      # laser: red, glow, core
}
g = [["." for _ in range(N)] for _ in range(N)]
def px(x, y, k):
    if 0 <= x < N and 0 <= y < N: g[y][x] = k
def rect(x0, y0, x1, y1, k):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1): px(x, y, k)
def ell(cx, cy, rx, ry, k, cond=lambda x, y: True):
    for y in range(N):
        for x in range(N):
            if ((x - cx + .5) / rx) ** 2 + ((y - cy + .5) / ry) ** 2 <= 1 and cond(x, y): px(x, y, k)

LASERS = "--no-lasers" not in sys.argv
# body
ell(20, 45, 18, 10, "B"); ell(20, 45, 18, 10, "b", lambda x, y: x < 10)
# thick chain (two rows) + a coin with the $
for i, x in enumerate(range(10, 31)):
    y = 30 + int(round(2.8 * math.sin(math.pi * (x - 10) / 20)))
    px(x, y, "Y" if i % 2 == 0 else "y"); px(x, y + 1, "y" if i % 2 == 0 else "Y")
ell(20, 34, 4.6, 4.6, "Y"); ell(20, 34, 4.6, 4.6, "y", lambda x, y: x >= 22 and y >= 35)
DOLLAR = ["..#..",
          ".###.",
          "#.#..",
          ".###.",
          "..#.#",
          ".###.",
          "..#.."]
for j, row in enumerate(DOLLAR):
    for i, ch in enumerate(row):
        if ch == "#": px(18 + i, 31 + j, "K")
px(17, 32, "W")
# head
ell(20, 18, 10.5, 10.5, "F")
ell(20, 18, 10.5, 10.5, "f", lambda x, y: x > 25 or y > 25)
ell(20, 18, 10.5, 10.5, "F", lambda x, y: x <= 25 and y <= 25)
for (x, y) in [(12, 20), (12, 21), (13, 21)]: px(x, y, "h")
rect(8, 17, 9, 20, "F"); px(8, 18, "f")                       # ear
# spiky blond hair (left) and tuft (right)
for (x, y) in [(8, 11), (9, 12), (7, 12), (8, 12), (7, 13), (8, 13), (9, 13), (8, 14), (9, 14), (8, 15), (10, 12),
               (31, 11), (32, 12), (31, 12), (31, 13), (32, 13), (31, 14)]: px(x, y, "Y")
for (x, y) in [(9, 15), (7, 14), (32, 14)]: px(x, y, "y")
for (x, y) in [(13, 10), (14, 11), (15, 10), (16, 11), (17, 10), (18, 11)]: px(x, y, "Y")
# cap: calotta + visiera all'indietro, in alto a destra
ell(20, 11, 10.5, 6, "C", lambda x, y: y <= 9)
rect(10, 8, 30, 9, "C")
rect(27, 4, 33, 6, "C")
for x in range(13, 26): px(x, 6, "c")
for (x, y) in [(17, 7), (18, 8), (19, 7), (20, 6), (21, 5)]: px(x, y, "G")   # check mark
# sunglasses
rect(9, 14, 31, 15, "S")
rect(11, 15, 18, 19, "S"); rect(22, 15, 29, 19, "S")
for (x, y) in [(12, 16), (13, 16), (12, 17), (23, 16), (24, 16), (23, 17)]: px(x, y, "W")
# huge grin with teeth and tongue
rect(12, 22, 28, 26, "M")
for x in range(13, 28): px(x, 22, "T")
for x in (15, 18, 21, 24): px(x, 22, "M")
for x in range(16, 25): px(x, 26, "t")
for x in range(17, 24): px(x, 25, "t")
px(11, 21, "M"); px(29, 21, "M")
for x in range(13, 28): px(x, 27, "f")

# outline automatico sul personaggio
filled = [[g[y][x] != "." for x in range(N)] for y in range(N)]
for y in range(N):
    for x in range(N):
        if not filled[y][x] and any(0 <= x + a < N and 0 <= y + b < N and filled[y + b][x + a] for a, b in [(1, 0), (-1, 0), (0, 1), (0, -1)]):
            g[y][x] = "K"
# laser eyes: after the outline, on top of everything, to the edges
if LASERS:
    for (x0, x1, y) in [(0, 11, 17), (29, 39, 17)]:
        for x in range(x0, x1 + 1):
            px(x, y - 1, "R"); px(x, y, "L"); px(x, y + 1, "R")
            if (x % 3) == 0: px(x, y - 2, "r"); px(x, y + 2, "r")
    for (x, y) in [(15, 17), (26, 17)]: px(x, y, "L"); px(x - 1, y, "R"); px(x + 1, y, "R")

def render(scale, bg=True):
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    for y in range(N):
        for x in range(N):
            k = g[y][x]
            if k == ".":
                if bg:
                    a = math.degrees(math.atan2(y - 17.5, x - 19.5)) % 360
                    img.putpixel((x, y), P["g"] + (255,) if int(a // 15) % 2 == 0 else P["G"] + (255,))
            else:
                img.putpixel((x, y), P[k] + (255,))
    return img.resize((N * scale, N * scale), Image.NEAREST)

tag = "" if LASERS else "-calm"
render(10).save(f"degen-pfp{tag}-400.png"); render(25).save(f"degen-pfp{tag}-1000.png"); render(25, False).save(f"degen-mascot{tag}-1000.png")
big = render(10); m = Image.new("L", big.size, 0); ImageDraw.Draw(m).ellipse((0, 0) + big.size, fill=255)
rd = Image.new("RGBA", big.size, (21, 32, 43, 255)); rd.paste(big, (0, 0), m)
sh = Image.new("RGBA", (400 + 20 + 48 + 20 + 32, 400), (21, 32, 43, 255)); sh.paste(rd, (0, 0))
sh.paste(rd.resize((48, 48), Image.LANCZOS), (420, 176)); sh.paste(rd.resize((32, 32), Image.LANCZOS), (488, 184)); sh.save(f"degen-preview{tag}.png")
print("ok")
