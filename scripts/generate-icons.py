"""Render platform icon formats from the approved SVG masters.

Run from the repository root with Pillow 11.3.0 and resvg-py 0.3.2 installed.
"""

from io import BytesIO
from pathlib import Path
from shutil import copyfile

from PIL import Image
from resvg_py import svg_to_bytes

ROOT = Path(__file__).resolve().parents[1]
WEB_SIZES = (16, 32, 48, 192, 512)
ICO_SIZES = [(size, size) for size in (16, 32, 48, 64, 128, 256)]


def render(source):
    return Image.open(
        BytesIO(svg_to_bytes(svg_path=str(ROOT / source), width=2048, height=2048))
    ).convert("RGBA")


def png(image, destination, size):
    image.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / destination)


for app in ("pane-view", "showcase"):
    directory = Path("apps") / app / "public"
    image = render(directory / "favicon.svg")
    png(image, directory / "favicon.png", 1024)
    for size in WEB_SIZES:
        png(image, directory / f"favicon-{size}.png", size)
    png(image, directory / "apple-touch-icon.png", 180)
    image.save(ROOT / directory / "favicon.ico", sizes=ICO_SIZES)

for app in ("frame-view", "lockstep"):
    base = Path("apps") / app / "media" / f"{app}-icon"
    image = render(base.with_suffix(".svg"))
    png(image, base.with_suffix(".png"), 1024)
    image.save(ROOT / base.with_suffix(".ico"), sizes=ICO_SIZES)
    image.resize((1024, 1024), Image.Resampling.LANCZOS).save(
        ROOT / base.with_suffix(".icns")
    )

extension = Path("apps/gather-box/assets/icons")
image = render(extension / "gather-box-icon.svg")
png(image, extension / "gather-box-icon.png", 1024)
for size in (16, 32, 48, 128):
    png(image, extension / f"icon{size}.png", size)

copyfile(
    ROOT / "apps/lockstep/media/lockstep-icon.png",
    ROOT / "apps/lockstep/media/lockstep-icon.icon/Assets/lockstep-icon.png",
)
copyfile(
    ROOT / "apps/lockstep/media/lockstep-icon.svg",
    ROOT / "apps/lockstep-cli/assets/lockstep-icon.svg",
)
