#!/usr/bin/env python3
"""Regenerate the prototype's FICTIONAL local data (placeholder images + seed catalogs).

    python3 _admin-prototype/tools/make_fictional_data.py

Every brand here is invented. URLs use example.com (links) and storage.example.invalid (images,
content-addressed by SHA-256 the way the real upload function will name them). The only real
identifier is `rvp-supply-oem-beadlocks`: the v1 contract reserves that id for the sponsor
layout, so the sponsor entry uses it with clearly placeholder copy and example.com links.
Requires Pillow (already used by scripts/optimize-images.py).
"""

from __future__ import annotations

import hashlib
import io
import json
import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGES = ROOT / "data" / "images"
STORAGE = "https://storage.example.invalid/recommended-gear/images"


def png(width: int, height: int, draw) -> bytes:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw(ImageDraw.Draw(image), width, height)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def store(brand: str, data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    IMAGES.mkdir(parents=True, exist_ok=True)
    (IMAGES / f"{digest}.png").write_bytes(data)
    return f"{STORAGE}/{brand}/{digest}.png"


def logo(color):
    def draw(d, w, h):
        d.rounded_rectangle((8, 8, h - 8, h - 8), radius=18, fill=color)
        for i in range(3):
            d.rectangle((h + 16 + i * 70, h * 0.3, h + 66 + i * 70, h * 0.7), fill=color)
    return draw


def hero(bg, fg):
    def draw(d, w, h):
        d.rectangle((0, 0, w, h), fill=bg)
        d.ellipse((w * 0.2, h * 0.15, w * 0.8, h * 0.85), fill=fg)
        d.rectangle((w * 0.42, h * 0.05, w * 0.58, h * 0.95), fill=bg)
    return draw


def wheel(color):
    def draw(d, w, h):
        d.ellipse((4, 4, w - 4, h - 4), fill=(30, 34, 42, 255))
        d.ellipse((w * 0.14, h * 0.14, w * 0.86, h * 0.86), fill=color)
        d.ellipse((w * 0.4, h * 0.4, w * 0.6, h * 0.6), fill=(30, 34, 42, 255))
    return draw


def main() -> None:
    northwind_logo = store("northwind-sensors", png(400, 100, logo((24, 93, 204, 255))))
    northwind_logo_dark = store("northwind-sensors", png(400, 100, logo((140, 186, 255, 255))))
    northwind_hero = store("northwind-sensors", png(800, 600, hero((228, 236, 248, 255), (24, 93, 204, 255))))
    tools_hero = store("example-fuel-tools", png(800, 600, hero((250, 241, 222, 255), (134, 86, 0, 255))))
    custom_wheel = store("rvp-supply-oem-beadlocks", png(400, 400, wheel((180, 186, 196, 255))))

    sponsor = {
        "id": "rvp-supply-oem-beadlocks", "kind": "rvp_wheels",
        "name": "Sample Wheel Sponsor",
        "tagline": "Placeholder sponsor tagline",
        "description": "Nine sample wheel designs for the prototype, or build your own.",
        "accessibilityDescription": "Sample sponsor wheels.",
        "ctaTitle": "View All Sample Wheels",
        "destinationURL": "https://example.com/sponsor/wheels",
        "homepageURL": "https://example.com/sponsor",
        "configuratorURL": "https://example.com/sponsor/configure",
        "footnote": "Fictional prototype data · Not real product information",
        "more": {"subtitle": "Placeholder More subtitle"},
        "wheels": [
            {"id": wid, "displayName": f"Sample Wheel {i + 1}", "accessibilityName": f"Sample Wheel {i + 1}",
             "productURL": f"https://example.com/sponsor/wheels/{i + 1}"}
            for i, wid in enumerate(["oem-hellcat", "oem-hellcat-v2", "oem-hellcat-redeye", "5-spoke-hellcat",
                                     "5-spoke-hellcat-v2", "oem-demon", "hollow-5-spoke", "chrome-oem-hellcat",
                                     "oem-widebody"])
        ],
    }
    example_tools = {
        "id": "example-fuel-tools", "kind": "brand",
        "name": "Example Fuel Tools",
        "tagline": "Fictional fuel-system tools",
        "description": "An invented brand used to try editing, ordering and offers in the prototype.",
        "ctaTitle": "View Example Products",
        "destinationURL": "https://example.com/fuel-tools",
        "priceText": "From $49",
        "more": {"subtitle": "Prototype More card"},
    }
    live_production = {
        "schemaVersion": 1, "revision": "prototype-seed-production-1", "publishedAt": 1_794_000_000,
        "brands": [example_tools, sponsor],
    }

    northwind = {
        "id": "northwind-sensors", "kind": "brand",
        "name": "Northwind Sensors",
        "tagline": "Fictional ethanol content sensors",
        "description": "Invented sensor kits with a remote logo and product photo, for testing images in the prototype.",
        "accessibilityDescription": "Northwind Sensors, fictional ethanol content sensor kits.",
        "ctaTitle": "View Northwind Kits",
        "destinationURL": "https://example.com/northwind",
        "logo": {"url": northwind_logo, "darkURL": northwind_logo_dark},
        "heroImageURL": northwind_hero,
        "priceText": "From $129",
        "more": {},
    }
    edited_tools = dict(example_tools, priceText="From $39", heroImageURL=tools_hero, offer={
        "amountOff": 10, "eligibleProducts": "example tool kits", "code": "EXAMPLE10",
        "terms": "Fictional offer for the prototype.", "disclosure": "Not a real promotion.",
        "startsAt": 1_794_000_000, "expiresAt": 1_826_496_000,
    })
    harbor = {
        "id": "harbor-garage-supply", "kind": "brand",
        "name": "Harbor Garage Supply",
        "tagline": "Fictional shop supplies",
        "description": "A hidden invented brand: present in the document but withdrawn from every screen.",
        "ctaTitle": "View Harbor Supplies",
        "destinationURL": "https://example.com/harbor",
        "hidden": True,
    }
    sponsor_draft = json.loads(json.dumps(sponsor))
    sponsor_draft["wheels"].append({
        "id": "sample-custom-wheel", "displayName": "Sample Custom Wheel",
        "accessibilityName": "Sample Custom Wheel", "productURL": "https://example.com/sponsor/wheels/custom",
        "imageURL": custom_wheel, "hidden": True,
    })
    draft = {
        "catalog": {"schemaVersion": 1, "brands": [northwind, edited_tools, sponsor_draft, harbor]},
        "meta": {
            "approvals": {
                "northwind-sensors": "pending", "example-fuel-tools": "approved",
                "rvp-supply-oem-beadlocks": "approved", "harbor-garage-supply": "approved",
            },
            "notes": {"northwind-sensors": "Fictional: waiting on (invented) partner sign-off."},
        },
    }
    data = ROOT / "data"
    (data / "fictional-live-production.json").write_text(json.dumps(live_production, indent=2) + "\n")
    (data / "fictional-draft.json").write_text(json.dumps(draft, indent=2) + "\n")
    print("wrote", data / "fictional-live-production.json", data / "fictional-draft.json", "and", IMAGES)


if __name__ == "__main__":
    main()
