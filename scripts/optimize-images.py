"""Lossless-source screenshot crops and web encodes; no generated or redrawn app UI."""
from pathlib import Path
from PIL import Image
BASE = Path(__file__).resolve().parents[1]
import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-dir", required=True, type=Path, help="Directory containing the genuine calculator-screen.png, stations-screen.png, and pump-instructions.png sources.")
SOURCE = parser.parse_args().source_dir
def encode(source, name, crop=None, width=660):
    image = Image.open(source).convert("RGB")
    if crop:
        image = image.crop(crop)
    if image.width > width:
        image = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
    image.save(BASE / "assets" / (name + ".webp"), "WEBP", quality=90, method=6)
    print(name, image.size)
for name, source in [("calculator", "calculator-screen.png"), ("stations", "stations-screen.png"), ("pump", "pump-instructions.png")]:
    encode(SOURCE / source, name + "-screen")
for name, source, box in [
    ("garage", "garage-hero.png", (700, 70, 1170, 900)),
    ("fuel-log", "fuel-log-hero.jpg", (774, 49, 1218, 924)),
    ("reminders", "reminders-hero.jpg", (786, 48, 1214, 937)),
]:
    encode(BASE / "assets" / source, name + "-screen", box)
icon = Image.open(BASE / "assets/app-icon.png").convert("RGB")
icon.resize((192, 192), Image.Resampling.LANCZOS).save(BASE / "assets/app-icon-small.png", optimize=True)
icon.resize((80, 80), Image.Resampling.LANCZOS).save(BASE / "assets/app-icon-small.webp", "WEBP", quality=90, method=6)
