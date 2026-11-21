# Generates the store promo images from the icon and a screenshot.
#   python3 store/promo.py
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def background(w, h):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=(int(24 + 10 * t), int(27 + 12 * t), int(36 + 30 * t)))
    return img

def icon(size):
    return Image.open(os.path.join(root, "icons", "128.png")).convert("RGBA").resize((size, size), Image.LANCZOS)

def tile():
    img = background(440, 280)
    img.paste(ic := icon(88), (40, 52), ic)
    d = ImageDraw.Draw(img)
    d.text((40, 160), "Three Inspector", font=ImageFont.truetype(BOLD, 34), fill=(240, 242, 246))
    d.text((40, 208), "Inspect and tweak three.js", font=ImageFont.truetype(REG, 19), fill=(170, 180, 198))
    d.text((40, 234), "scenes live in DevTools", font=ImageFont.truetype(REG, 19), fill=(170, 180, 198))
    img.save(os.path.join(here, "promo-small-440x280.png"), optimize=True)

def marquee():
    img = background(1400, 560)
    shot = Image.open(os.path.join(here, "screenshots", "2-materials.png")).convert("RGB")
    shot = shot.resize((760, 475), Image.LANCZOS)
    shadow = Image.new("RGBA", (800, 515), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([20, 20, 780, 495], 12, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    img.paste(shadow, (580, 30), shadow)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *shot.size], 10, fill=255)
    img.paste(shot, (600, 42), mask)
    img.paste(ic := icon(96), (70, 120), ic)
    d = ImageDraw.Draw(img)
    d.text((70, 240), "Three Inspector", font=ImageFont.truetype(BOLD, 50), fill=(240, 242, 246))
    for i, line in enumerate(["Browse three.js scene graphs and tweak", "objects, materials and lights live."]):
        d.text((70, 318 + i * 34), line, font=ImageFont.truetype(REG, 24), fill=(170, 180, 198))
    img.save(os.path.join(here, "promo-marquee-1400x560.png"), optimize=True)

tile()
marquee()
