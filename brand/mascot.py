# Jev Said It mascot: REAL pixel art, on a 50x50 grid, drawn with integer primitives
# (no antialiasing) and scaled up with nearest-neighbor. Palette = the site's.
from PIL import Image
import math, sys

N = 50
PAL = {
    ".": None,            # transparent / background
    "G": (61, 240, 122),  # hood green #3DF07A (background)
    "g": (46, 201, 99),   # dark background green (dither)
    "K": (8, 18, 11),     # near-black outline #07120B
    "C": (20, 24, 22),    # cap
    "c": (40, 48, 44),    # cap highlight
    "F": (245, 154, 143), # face #F59A8F
    "f": (214, 118, 110), # face shadow
    "h": (255, 190, 176), # face highlight
    "Y": (242, 194, 48),  # gold / blond #F2C230
    "y": (196, 146, 24),  # gold shadow
    "W": (255, 247, 214), # warm white (highlights)
    "S": (10, 10, 12),    # sunglasses
    "B": (14, 42, 23),    # hoodie #0E2A17
    "b": (26, 64, 38),    # hoodie highlight
    "M": (150, 60, 62),   # mouth
    "V": (61, 240, 122),  # check mark on the medallion (green)
}

g = [["." for _ in range(N)] for _ in range(N)]
def px(x, y, k):
    if 0 <= x < N and 0 <= y < N: g[y][x] = k
def rect(x0, y0, x1, y1, k):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1): px(x, y, k)
def ellipse(cx, cy, rx, ry, k, cond=lambda x, y: True):
    for y in range(N):
        for x in range(N):
            if ((x - cx + .5) / rx) ** 2 + ((y - cy + .5) / ry) ** 2 <= 1 and cond(x, y): px(x, y, k)

# --- hoodie (shoulders) with hood and drawstrings ---
ellipse(25, 53, 22, 14, "B")
ellipse(25, 53, 22, 14, "b", lambda x, y: x < 15 and y > 42)
ellipse(25, 41, 10, 4, "b", lambda x, y: y >= 39)                      # hood rim
ellipse(25, 41, 8, 3, "B", lambda x, y: y >= 40)
for (x, y) in [(21, 44), (21, 45), (21, 46), (29, 44), (29, 45), (29, 46)]: px(x, y, "W")  # drawstrings
px(21, 47, "y"); px(29, 47, "y")
# --- head: narrower chin ---
ellipse(25, 24, 11, 12, "F")
ellipse(25, 24, 11, 12, "f", lambda x, y: x > 31 or y > 32)
ellipse(25, 24, 11, 12, "F", lambda x, y: x <= 31 and y <= 32)
for (x, y) in [(14, 33), (15, 34), (35, 33), (34, 34)]: px(x, y, ".")  # chin
for (x, y) in [(18, 28), (18, 29), (19, 29)]: px(x, y, "h")            # cheek highlight
rect(13, 24, 14, 27, "F"); px(13, 25, "f"); px(13, 26, "f")             # ear
rect(22, 36, 28, 37, "f")                                               # neck
# --- blond hair: spiky tufts sticking out of the cap ---
for (x, y) in [(12, 17), (13, 17), (12, 18), (13, 18), (14, 18), (11, 19), (12, 19), (13, 19),
               (12, 20), (13, 20), (14, 20), (12, 21), (13, 21), (13, 22), (14, 22), (14, 23),
               (37, 18), (38, 18), (37, 19), (38, 19), (39, 19), (37, 20), (38, 20), (36, 21), (37, 21), (37, 22)]:
    px(x, y, "Y")
for (x, y) in [(13, 23), (14, 21), (38, 20), (37, 23), (12, 21)]: px(x, y, "y")
for (x, y) in [(16, 19), (17, 19), (17, 20), (18, 19), (19, 20), (20, 19), (21, 20)]: px(x, y, "Y")  # fringe
for (x, y) in [(18, 20), (20, 20)]: px(x, y, "y")
# --- cap with the visor to the right ---
ellipse(25, 17, 12, 8, "C", lambda x, y: y <= 16)
rect(14, 15, 36, 17, "C")
rect(33, 16, 44, 18, "C")
for x in range(34, 44): px(x, 16, "c")
for x in range(18, 31): px(x, 11, "c")
px(25, 9, "c")                                                          # button
for y in range(10, 17): px(25, y, "c") if y % 2 == 0 else None          # seam
for (x, y) in [(20, 13), (21, 14), (22, 13), (23, 12), (24, 11)]: px(x, y, "V")  # check mark
# --- "deal with it" sunglasses ---
rect(14, 21, 37, 22, "S")
rect(16, 22, 23, 26, "S")
rect(27, 22, 34, 26, "S")
px(16, 26, "F"); px(27, 26, "F")
for (x, y) in [(17, 23), (18, 23), (17, 24), (28, 23), (29, 23), (28, 24)]: px(x, y, "W")
# --- mouth: smirk with one corner raised ---
for x in range(21, 29): px(x, 31, "M")
px(29, 30, "M"); px(30, 29, "M"); px(30, 30, "f")
for x in range(23, 28): px(x, 32, "f")                                  # lower lip
# --- thick gold chain and medallion ---
for i, x in enumerate(range(16, 35)):
    y = 38 + int(round(2.6 * math.sin(math.pi * (x - 16) / 18)))
    px(x, y, "Y" if i % 2 == 0 else "y"); px(x, y + 1, "y" if i % 2 == 0 else "Y")
ellipse(25, 45, 4, 4, "Y")
ellipse(25, 45, 4, 4, "y", lambda x, y: x >= 26 and y >= 46)
for (x, y) in [(23, 45), (24, 46), (25, 45), (26, 44), (27, 43)]: px(x, y, "K")
px(22, 43, "W")

# --- automatic outline: every empty pixel next to the character becomes outline ---
filled = [[g[y][x] != "." for x in range(N)] for y in range(N)]
for y in range(N):
    for x in range(N):
        if not filled[y][x] and any(0 <= x + dx < N and 0 <= y + dy < N and filled[y + dy][x + dx]
                                     for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]):
            g[y][x] = "K"

def render(scale, bg=True, path=None):
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    for y in range(N):
        for x in range(N):
            k = g[y][x]
            if k == "." :
                if bg:
                    # green background with a light dither toward the edges (it disappears in the round crop)
                    d = math.hypot(x - 24.5, y - 24.5)
                    img.putpixel((x, y), PAL["g"] + (255,) if d > 22 and (x + y) % 2 == 0 else PAL["G"] + (255,))
            else:
                img.putpixel((x, y), PAL[k] + (255,))
    img = img.resize((N * scale, N * scale), Image.NEAREST)
    if path: img.save(path)
    return img

out = sys.argv[1] if len(sys.argv) > 1 else "."
render(8, True, f"{out}/pfp-400.png")
render(20, True, f"{out}/pfp-1000.png")
render(20, False, f"{out}/mascot-1000-transparent.png")
# preview as X shows it: round, and small
from PIL import ImageDraw
big = render(8, True)
mask = Image.new("L", big.size, 0); ImageDraw.Draw(mask).ellipse((0, 0) + big.size, fill=255)
round_ = Image.new("RGBA", big.size, (21, 32, 43, 255)); round_.paste(big, (0, 0), mask)
sheet = Image.new("RGBA", (400 + 20 + 48 + 20 + 32, 400), (21, 32, 43, 255))
sheet.paste(round_, (0, 0)); sheet.paste(round_.resize((48, 48), Image.LANCZOS), (420, 176)); sheet.paste(round_.resize((32, 32), Image.LANCZOS), (488, 184))
sheet.save(f"{out}/pfp-preview.png")
print("ok")
