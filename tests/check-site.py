"""Dependency-free static checks, including exact preservation of legal document text."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import json
import re
import subprocess

BASE = Path(__file__).resolve().parents[1]
class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids=[]; self.refs=[]; self.h1=0; self.json_scripts=[]; self.in_json=False; self.buffer=""
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if "id" in attrs: self.ids.append(attrs["id"])
        if tag == "h1": self.h1 += 1
        for attr in ("href", "src"):
            if attr in attrs: self.refs.append(attrs[attr])
        if tag=="script" and attrs.get("type")=="application/ld+json": self.in_json=True; self.buffer=""
        if tag=="img": assert "alt" in attrs, "Missing image alt"
    def handle_data(self,data):
        if self.in_json: self.buffer += data
    def handle_endtag(self,tag):
        if tag=="script" and self.in_json:
            self.json_scripts.append(json.loads(self.buffer)); self.in_json=False

pages={}
shells=[]
for file in sorted(BASE.glob("*.html")):
    source=file.read_text()
    doc=Page(); doc.feed(source); pages[file.name]=doc
    header=re.search(r'<header[\s\S]*?</header>',source).group()
    footer=re.search(r'<footer[\s\S]*?</footer>',source).group()
    shells.append((re.sub(r' aria-current="page"','',header),footer))
    assert doc.h1==1, (file.name, "h1 count", doc.h1)
    assert len(doc.ids)==len(set(doc.ids)), (file.name,"duplicate id")
    assert "main-content" in doc.ids
    assert "mobile-navigation" in doc.ids
assert len(pages)==10
assert all(shell==shells[0] for shell in shells), "Shared header/footer drift"
for name,doc in pages.items():
    for ref in doc.refs:
        url=urlsplit(ref)
        if url.scheme or url.netloc: continue
        path=unquote(url.path)
        target=BASE/(path.lstrip("/") or name) if path else BASE/name
        if path=="/": target=BASE/"index.html"
        assert target.exists(), (name,"missing local target",ref)
        if url.fragment and target.suffix==".html":
            assert url.fragment in pages[target.name].ids,(name,"missing fragment",ref)

class Text(HTMLParser):
    def __init__(self): super().__init__(); self.text=[]
    def handle_data(self,data): self.text.append(data)
def legal_text(html):
    start=html.index('<section class="')
    # Original main contains one legal card; refreshed main contains one legal-body.
    if '<section class="legal-body">' in html: start=html.index('<section class="legal-body">')
    else: start=html.index('<section class="card">',html.index("<main>"))
    end=html.index("</section>",start)
    parser=Text(); parser.feed(html[start:end]); return " ".join(" ".join(parser.text).split())
# Terms text must remain unchanged; Privacy is intentionally updated for Android and data deletion.
before=subprocess.check_output(["git","show","origin/main:terms.html"],cwd=BASE,text=True)
after=(BASE/"terms.html").read_text()
assert legal_text(before)==legal_text(after),("terms.html","legal text changed")
privacy=(BASE/"privacy.html").read_text()
deletion=(BASE/"data-deletion.html").read_text()
support=(BASE/"support.html").read_text()
for required in ('Last updated: October 20, 2026', 'id="policy-13"', 'Supabase', 'Android', 'iCloud', '/data-deletion.html'):
    assert required in privacy, ("privacy disclosure missing", required)
for required in ("Request data deletion", "85Blends Data Deletion Request", "support@85blends.app", "Android", "iPhone", "no universal automatic 90-day", 'id="request"', 'id="scope"'):
    assert required in deletion, ("data-deletion page missing", required)
assert '/data-deletion.html' in support, "Support must link to data deletion"
android=(BASE/"android.html").read_text()
assert "not available on Google Play yet" in android, "Android page must state its release status"
assert "Android · in active development" in android
assert "no Google Play download link" in android
assert "https://www.instagram.com/85blendsapp/" in android
for file in ("index.html","features.html","about.html","whats-new.html"):
    source=(BASE/file).read_text()
    assert "Price Alerts are planned" not in source, (file,"stale Price Alerts promise")
    assert "public App Store version is currently 2.3.2" not in source, (file,"stale release claim")
    assert "/android.html" in source, (file,"missing Android entry")
sitemap=(BASE/"sitemap.xml").read_text()
assert "https://85blends.app/android.html" in sitemap, "Android page missing from sitemap"


home=(BASE/"index.html").read_text()
for schema in pages["index.html"].json_scripts:
    if schema.get("@type") != "FAQPage": continue
    for entry in schema["mainEntity"]:
        match=re.search(r'<summary>'+re.escape(entry['name'])+r'</summary>\s*<p>([\s\S]*?)</p>',home)
        assert match, ("FAQ not visible",entry['name'])
        text=Text(); text.feed(match.group(1))
        assert " ".join("".join(text.text).split())==entry['acceptedAnswer']['text'],("FAQ schema drift",entry['name'])

print("PASS: 10 pages, single h1, unique IDs, local files/anchors, image alt, valid structured data.")
print("PASS: Terms text preserved; privacy/data-deletion content and support link validated.")
print("PASS: Shared header/footer match on all pages; FAQ structured data matches visible answers.")
