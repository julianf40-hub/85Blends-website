from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://85blends.app"


def add_breadcrumb(path_name, page_name, page_url):
    path = ROOT / path_name
    text = path.read_text(encoding="utf-8")
    if '"@type":"BreadcrumbList"' in text:
        return
    schema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "85Blends", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": page_name, "item": SITE + page_url},
        ],
    }
    tag = '  <script type="application/ld+json">' + json.dumps(schema, separators=(",", ":")) + '</script>\n'
    if "</head>" not in text:
        raise SystemExit(f"Missing </head> in {path_name}")
    path.write_text(text.replace("</head>", tag + "</head>", 1), encoding="utf-8")


whats = ROOT / "whats-new.html"
text = whats.read_text(encoding="utf-8")
old = '<p>Technical cleanup and optimization come first, followed by Pro station price alerts. Until then, the website will label Price Alerts as coming in 2.4.1 rather than an already-live feature.</p>'
new = '<p>Price Alerts are planned as the next major Pro feature for 2.4.1, alongside continued performance, reliability, and technical improvements.</p>'
if old not in text:
    raise SystemExit("Expected internal-facing 2.4.1 copy not found")
whats.write_text(text.replace(old, new, 1), encoding="utf-8")

add_breadcrumb("e85-calculator.html", "Free E85 Blend Calculator", "/e85-calculator.html")
add_breadcrumb("whats-new.html", "What's New", "/whats-new.html")

# Verify the calculator's default inputs produce a reachable fill rather than an error state.
T, C, Ec, Et, Ee, Eg = 18.5, 2.0, 0.10, 0.60, 0.70, 0.10
fill = T - C
high = (T * Et - C * Ec - fill * Eg) / (Ee - Eg)
gas = fill - high
assert 0 <= high <= fill and 0 <= gas <= fill

for path in ROOT.glob("*.html"):
    html = path.read_text(encoding="utf-8")
    assert "</body>>" not in html, path.name
    assert 'rel="canonical"' in html, path.name

assert '"@type":"BreadcrumbList"' in (ROOT / "e85-calculator.html").read_text(encoding="utf-8")
assert '"@type":"BreadcrumbList"' in (ROOT / "whats-new.html").read_text(encoding="utf-8")
assert "website will label" not in (ROOT / "whats-new.html").read_text(encoding="utf-8")
print(f"Post-refresh validation passed; default calculator fill = {high:.2f} gal high-ethanol + {gas:.2f} gal gasoline")
