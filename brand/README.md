# Brand: mascot, pfp, banner

Real pixel art: integer grids drawn by code and scaled up with nearest-neighbor, no
blending. It stays sharp at every integer size, even at 48 px (the avatar in the timeline).
Palette = the site's (`site/README.md`, Design).

| file | use |
|---|---|
| `pfp-400.png` | X avatar (50x50 x8) |
| `pfp-1000.png` | high-resolution avatar; it is also `site/public/mascot.png` |
| `mascot-1000-transparent.png` | the mascot without background, for posts and memes |
| `banner-1500x500.png` | X header |
| `site/public/brand/og-jev-1200x630.png` | link preview (Open Graph / X card): the **degen** banner, 1200x400 nearest, pasted at y=115 on `#091a0f` — not `banner.py`'s own `og-jev-1200x630.png`, which is a different design |

Regenerate:

```bash
cd brand
curl -sL -o PixelifySans.ttf "https://github.com/google/fonts/raw/main/ofl/pixelifysans/PixelifySans%5Bwght%5D.ttf"
curl -sL -o MartianMono.ttf  "https://github.com/google/fonts/raw/main/ofl/martianmono/MartianMono%5Bwdth%2Cwght%5D.ttf"
python3 mascot.py . && python3 banner.py
```

The fonts (OFL) are not in the repo. The mascot lives in `mascot.py`: every pixel is a coordinate,
so a variant (expression, accessory) is a change of a few lines.

In the banner the token address is deliberately fake (`0x0000…1d17`, like the site's sample
receipt): a real address from another project would look like an endorsement.

## Degen set (the one on X)

| file | use |
|---|---|
| `degen-pfp-400.png` | X avatar, laser version (40x40 x10) |
| `degen-pfp-calm-400.png` | same character without lasers |
| `degen-mascot-1000.png` | laser mascot without background, for posts |
| `degen-banner-1500x500.png` | X header ("SO I APED.") |
| `site/public/mascot-laser.png` | the native 40x40 sprite the site scales in CSS |

`python3 degen.py && python3 degen.py --no-lasers && python3 degen_banner.py`
