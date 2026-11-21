# Stacks the page and DevTools captures into one 1280x800 image.
import sys
from PIL import Image
tmp, out = sys.argv[1], sys.argv[2]
page = Image.open(f"{tmp}/page.png").convert("RGB")
dev = Image.open(f"{tmp}/devtools.png").convert("RGB")
W, H = 1280, 800
img = Image.new("RGB", (W, H), (32, 33, 36))
dev_h = min(dev.height, H)
img.paste(page.crop((0, 0, W, H - dev_h)), (0, 0))
img.paste(dev.crop((0, 0, W, dev_h)), (0, H - dev_h))
img.save(out, optimize=True)
print(out.split("/")[-1], "page", page.size, "devtools", dev.size)
