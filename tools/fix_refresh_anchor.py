from pathlib import Path

path = Path(__file__).with_name("refresh_2_4_site.py")
text = path.read_text(encoding="utf-8")
old = "text = insert_before_once(text, '<section class=\"blend-calc-section\">', release, \"WEBSITE REFRESH 2.4 RELEASE\")"
new = "text = insert_before_once(text, '<section id=\"blend-calculator\" class=\"blend-calc-section\">', release, \"WEBSITE REFRESH 2.4 RELEASE\")"
if old not in text and new not in text:
    raise SystemExit("Expected refresh anchor expression not found")
if old in text:
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Refresh insertion anchor corrected")
