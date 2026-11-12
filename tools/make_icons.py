"""Рисует иконки PWA в web/icons. Запуск из корня проекта: pip install pillow && python tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = "web/icons"
BG, RED, GREY, BLUE = (26, 26, 25), (230, 103, 103), (139, 138, 130), (57, 135, 229)

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="113" fill="#1a1a19"/>
<rect x="77" y="207" width="108" height="82" rx="13" fill="#e66767"/>
<rect x="191" y="207" width="137" height="82" rx="13" fill="#8b8a82"/>
<rect x="334" y="207" width="101" height="82" rx="13" fill="#3987e5"/>
<rect x="77" y="312" width="86" height="20" rx="10" fill="#e66767"/>
<rect x="169" y="312" width="157" height="20" rx="10" fill="#8b8a82"/>
<rect x="332" y="312" width="103" height="20" rx="10" fill="#3987e5"/>
</svg>
"""


def draw(size, rounded, inset):
    S = size * 4                                   # рисуем в 4x и уменьшаем: гладкие края
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=BG)
    else:
        d.rectangle((0, 0, S, S), fill=BG)
    w, x0, gap = S * (1 - 2 * inset), S * inset, S * 0.012

    def strip(y, h, parts, r):
        avail, x = w - gap * (len(parts) - 1), x0
        for p, c in zip(parts, (RED, GREY, BLUE)):
            ww = avail * p / sum(parts)
            d.rounded_rectangle((x, y, x + ww, y + h), radius=r, fill=c)
            x += ww + gap

    cy = S * 0.5
    strip(cy - S * 0.095, S * 0.16, (30, 38, 32), S * 0.025)   # модель
    strip(cy + S * 0.11, S * 0.04, (23, 42, 35), S * 0.02)     # база
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
draw(512, True, 0.15).save(f"{OUT}/icon-512.png")
draw(192, True, 0.15).save(f"{OUT}/icon-192.png")
draw(512, False, 0.24).save(f"{OUT}/icon-maskable-512.png")
draw(180, False, 0.19).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
with open(f"{OUT}/icon.svg", "w", encoding="utf-8") as f:
    f.write(SVG)
print("готово:", ", ".join(sorted(os.listdir(OUT))))
