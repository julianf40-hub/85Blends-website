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
assert len(pages)==8
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
for file in ("privacy.html","terms.html"):
    before=subprocess.check_output(["git","show","origin/main:"+file],cwd=BASE,text=True)
    after=(BASE/file).read_text()
    assert legal_text(before)==legal_text(after),(file,"legal text changed")

home=(BASE/"index.html").read_text()
for schema in pages["index.html"].json_scripts:
    if schema.get("@type") != "FAQPage": continue
    for entry in schema["mainEntity"]:
        match=re.search(r'<summary>'+re.escape(entry['name'])+r'</summary>\s*<p>([\s\S]*?)</p>',home)
        assert match, ("FAQ not visible",entry['name'])
        text=Text(); text.feed(match.group(1))
        assert " ".join("".join(text.text).split())==entry['acceptedAnswer']['text'],("FAQ schema drift",entry['name'])

print("PASS: 8 pages, single h1, unique IDs, local files/anchors, image alt, valid structured data.")
print("PASS: Privacy and Terms document text is unchanged from origin/main.")
print("PASS: Shared header/footer match on all pages; FAQ structured data matches visible answers.")
