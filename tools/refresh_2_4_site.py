#!/usr/bin/env python3
from pathlib import Path
import html
import json
import re

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://85blends.app"
APP_STORE = "https://apps.apple.com/us/app/85blends/id6762037468"
INSTAGRAM = "https://www.instagram.com/85blendsapp/"

PAGES = {
    "index.html": ("/", "85Blends – E85 Calculator, Ethanol Blend Calculator & Trip Planner for iPhone", "Calculate E30, E50, E60 and E85 blends, find nearby E85 stations, plan road trips, compare fuel costs, and manage your flex-fuel setup with 85Blends for iPhone."),
    "features.html": ("/features.html", "85Blends Features – E85 Calculator, Station Finder, Widgets & Trip Planner", "Explore 85Blends features including ethanol blend calculations, E85 station discovery, community ethanol reports, Home Screen widgets, trip planning, fuel logs, reminders, and Pro tools."),
    "about.html": ("/about.html", "About – 85Blends E85 Calculator & Trip Planner", "Learn how 85Blends grew from one E85 enthusiast's need for better blend and station tools into a growing flex-fuel community app."),
    "support.html": ("/support.html", "85Blends Support", "Get help with 85Blends, review common resources, learn about the latest release, and contact support."),
    "privacy.html": ("/privacy.html", "Privacy Policy – 85Blends", "Read the 85Blends privacy policy, including information about location features, community fuel data, subscriptions, ads, and iCloud sync."),
    "terms.html": ("/terms.html", "Terms of Use – 85Blends", "Read the terms of use for the 85Blends iPhone app and website."),
}

ORG_SCHEMA = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "JF Apps",
    "url": SITE,
    "brand": {"@type": "Brand", "name": "85Blends"},
    "logo": f"{SITE}/assets/app-icon.png",
    "sameAs": [INSTAGRAM],
}

SOFTWARE_SCHEMA = {
    "@context": "https://schema.org",
    "@type": "MobileApplication",
    "name": "85Blends",
    "operatingSystem": "iOS",
    "applicationCategory": "UtilitiesApplication",
    "url": APP_STORE,
    "downloadUrl": APP_STORE,
    "description": "E85 and ethanol blend calculator, station finder, trip planner, fuel log, community fuel data, and flex-fuel utility for iPhone.",
    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
}

FAQ_SCHEMA = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
        {
            "@type": "Question",
            "name": "How much E85 do I need for E30?",
            "acceptedAnswer": {"@type": "Answer", "text": "The amount depends on tank size, fuel already in the tank, the current ethanol percentage, and the actual ethanol content of the fuel at the pump. 85Blends calculates the gallons needed for your specific inputs."},
        },
        {
            "@type": "Question",
            "name": "How do I calculate an E60 blend?",
            "acceptedAnswer": {"@type": "Answer", "text": "Enter tank size, the amount and ethanol percentage already in the tank, the target blend, and the pump-fuel ethanol percentages. In the United States, regular pump gasoline is commonly E10 rather than E0, so use the pump label or a measured value when available."},
        },
        {
            "@type": "Question",
            "name": "Can my car run E85?",
            "acceptedAnswer": {"@type": "Answer", "text": "Flexible-fuel vehicles are designed for high-ethanol fuels. Modified performance vehicles may also support higher ethanol blends when equipped and tuned appropriately. Follow your vehicle manufacturer's fuel requirements or your tuner's recommendations before using ethanol concentrations beyond those approved for your vehicle."},
        },
    ],
}


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def write(name, text):
    (ROOT / name).write_text(text, encoding="utf-8")


def insert_before_once(text, marker, block, fingerprint):
    if fingerprint in text:
        return text
    if marker not in text:
        raise RuntimeError(f"Required marker missing: {marker!r}")
    return text.replace(marker, block + "\n" + marker, 1)


def add_head_metadata(text, path, title, description, extra_schema=None):
    # Normalize title/description so social metadata and search snippets stay in sync.
    text = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", text, count=1, flags=re.S)
    desc_tag = f'<meta name="description" content="{html.escape(description, quote=True)}">'
    if re.search(r'<meta\s+name=["\']description["\']', text, flags=re.I):
        text = re.sub(r'<meta\s+name=["\']description["\'][^>]*>', desc_tag, text, count=1, flags=re.I)
    else:
        text = text.replace("</title>", "</title>\n  " + desc_tag, 1)

    if 'rel="canonical"' in text:
        return text

    canonical = SITE + path
    schemas = [ORG_SCHEMA]
    if path == "/":
        schemas += [SOFTWARE_SCHEMA, FAQ_SCHEMA]
    if path != "/":
        crumbs = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "85Blends", "item": SITE + "/"},
                {"@type": "ListItem", "position": 2, "name": title.split(" – ")[0], "item": canonical},
            ],
        }
        schemas.append(crumbs)
    if extra_schema:
        schemas.extend(extra_schema)

    social = f'''\n  <link rel="canonical" href="{canonical}" />
  <link rel="icon" href="/assets/app-icon.png" />
  <link rel="apple-touch-icon" href="/assets/app-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="apple-itunes-app" content="app-id=6762037468" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="85Blends" />
  <meta property="og:title" content="{html.escape(title, quote=True)}" />
  <meta property="og:description" content="{html.escape(description, quote=True)}" />
  <meta property="og:url" content="{canonical}" />
  <meta property="og:image" content="{SITE}/assets/main-hero.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{html.escape(title, quote=True)}" />
  <meta name="twitter:description" content="{html.escape(description, quote=True)}" />
  <meta name="twitter:image" content="{SITE}/assets/main-hero.png" />
'''
    for schema in schemas:
        social += '  <script type="application/ld+json">' + json.dumps(schema, separators=(",", ":")) + "</script>\n"
    return text.replace("</head>", social + "</head>", 1)


def enhance_footer_links(text):
    pattern = re.compile(r'(<h4>Company</h4>\s*<ul>)(.*?)(</ul>)', re.S)
    match = pattern.search(text)
    if not match:
        return text
    body = match.group(2)
    additions = []
    if '/whats-new.html' not in body:
        additions.append('          <li><a href="/whats-new.html">What\'s New</a></li>')
    if '/e85-calculator.html' not in body:
        additions.append('          <li><a href="/e85-calculator.html">Free E85 Calculator</a></li>')
    if 'instagram.com/85blendsapp' not in body:
        additions.append(f'          <li><a href="{INSTAGRAM}" target="_blank" rel="noopener">Instagram @85blendsapp</a></li>')
    if not additions:
        return text
    new_body = body.rstrip() + "\n" + "\n".join(additions) + "\n        "
    return text[:match.start()] + match.group(1) + new_body + match.group(3) + text[match.end():]


def add_index_refresh(text):
    # Correct educational wording.
    text = text.replace(
        'Open the Blend Calculator, enter your tank size, your current ethanol percentage (usually E0 for pump gas), and set your target to E60. 85Blends instantly shows the exact gallons of E85 and regular gas to add.',
        'Open the Blend Calculator, enter your tank size, the amount and ethanol percentage already in the tank, and set your target to E60. In the U.S., regular pump gasoline is commonly E10 rather than E0, so check the pump label or use a measured value when available. 85Blends then shows the gallons needed for your inputs.'
    )
    text = text.replace(
        "Flex-fuel vehicles (FFVs) are factory-rated for E85. Many other vehicles can run partial blends like E30 without modification, but running high ethanol in a non-flex-fuel car without proper tuning can cause issues. Check your owner's manual or consult a tuner for your specific build.",
        "Flex-fuel vehicles (FFVs) are designed for high-ethanol fuels. Modified performance vehicles may also support higher ethanol blends when equipped and tuned appropriately. Always follow your vehicle manufacturer's fuel requirements or your tuner's recommendations before using ethanol concentrations beyond those approved for your vehicle."
    )

    # Refresh Free vs Pro table without claiming 2.4.1 price alerts are already available.
    text = text.replace(
        '        <tr><td>Station Finder</td><td><span class="plans-check">✓</span></td><td><span class="plans-pro-check">✓</span></td></tr>',
        '        <tr><td>Station Finder</td><td><span class="plans-check">✓</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n'
        '        <tr><td>Community Prices</td><td><span class="plans-check">✓</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n'
        '        <tr><td>Community Ethanol Reports</td><td><span class="plans-check">✓</span></td><td><span class="plans-pro-check">✓</span></td></tr>'
    )
    text = text.replace(
        '        <tr><td>Pro Stations Map</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n        <tr><td>Price Alerts</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>',
        '        <tr><td>Pro Stations Map</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n'
        '        <tr><td>Nearby E85 Home Screen Widgets</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n'
        '        <tr><td>Ad-Free Experience</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>\n'
        '        <tr><td>Price Alerts</td><td><span class="plans-dash">—</span></td><td><strong style="color:#92600A;">Coming in 2.4.1</strong></td></tr>'
    )

    refresh_css = '''
    /* ─── WEBSITE REFRESH 2.4 ─────────────────────────── */
    .trust-strip { border-bottom:1px solid #E5E7EB; background:#F8FAFC; padding:14px 24px; }
    .trust-strip-inner { max-width:1180px; margin:0 auto; display:flex; flex-wrap:wrap; justify-content:center; gap:10px 24px; color:#475569; font-size:13px; font-weight:700; }
    .trust-dot { color:var(--gold); }
    .release-section { padding:80px; background:linear-gradient(180deg,#0D1320 0%,#121B2D 100%); color:white; }
    .release-inner { max-width:1180px; margin:0 auto; }
    .release-kicker { color:var(--gold); font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; margin-bottom:10px; }
    .release-title { font-family:'Bebas Neue',sans-serif; font-size:clamp(38px,5vw,58px); line-height:1; margin-bottom:12px; }
    .release-sub { color:#AAB4C5; max-width:720px; line-height:1.7; margin-bottom:30px; }
    .release-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
    .release-card { border:1px solid rgba(255,255,255,.11); background:rgba(255,255,255,.055); border-radius:18px; padding:24px; }
    .release-card .tag { display:inline-flex; padding:5px 9px; border-radius:999px; background:rgba(245,168,0,.13); color:#FFD166; font-size:11px; font-weight:800; margin-bottom:12px; }
    .release-card h3 { font-size:18px; margin-bottom:8px; }
    .release-card p { color:#AAB4C5; font-size:14px; line-height:1.65; }
    .release-actions { margin-top:26px; display:flex; flex-wrap:wrap; gap:12px; }
    .release-actions a { text-decoration:none; font-weight:800; border-radius:10px; padding:12px 16px; }
    .release-actions .primary { background:var(--gold); color:var(--navy); }
    .release-actions .secondary { border:1px solid rgba(255,255,255,.18); color:white; }
    .plan-options { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; max-width:900px; margin:26px auto 0; }
    .plan-option { background:white; border:1.5px solid #E5E7EB; border-radius:14px; padding:18px; text-align:center; }
    .plan-option.best { border-color:var(--gold); box-shadow:0 8px 26px rgba(245,168,0,.12); }
    .plan-option .plan-name { font-weight:800; color:#334155; font-size:14px; }
    .plan-option .plan-price { font-family:'Bebas Neue',sans-serif; font-size:32px; color:var(--navy); margin:5px 0 0; }
    .plan-option .plan-note { color:#64748B; font-size:12px; }
    .partner-section { padding:72px 80px; background:#F8FAFC; border-top:1px solid #E5E7EB; }
    .partner-inner { max-width:1040px; margin:0 auto; }
    .partner-card { display:grid; grid-template-columns:140px 1fr auto; gap:28px; align-items:center; background:white; border:1.5px solid #E5E7EB; border-radius:18px; padding:26px; text-decoration:none; color:inherit; }
    .partner-card img { width:130px; max-height:70px; object-fit:contain; }
    .partner-card h3 { margin:0 0 6px; font-size:19px; }
    .partner-card p { color:#64748B; line-height:1.6; font-size:14px; }
    .partner-card .partner-cta { color:var(--blue); font-weight:800; white-space:nowrap; }
    .partner-note { margin-top:12px; color:#64748B; text-align:center; font-size:12px; }
    @media(max-width:800px){ .release-section,.partner-section{padding:56px 24px}.release-grid{grid-template-columns:1fr}.plan-options{grid-template-columns:1fr}.partner-card{grid-template-columns:1fr;text-align:center}.partner-card img{margin:auto}.partner-card .partner-cta{white-space:normal} }
'''
    if "WEBSITE REFRESH 2.4" not in text:
        text = text.replace("</style>", refresh_css + "\n  </style>", 1)

    trust = '''<!-- WEBSITE REFRESH TRUST STRIP -->
<div class="trust-strip" aria-label="85Blends product highlights">
  <div class="trust-strip-inner">
    <span>Blend Calculator</span><span class="trust-dot">•</span>
    <span>Live E85 Stations</span><span class="trust-dot">•</span>
    <span>Community Fuel Data</span><span class="trust-dot">•</span>
    <span>Trip Planning</span><span class="trust-dot">•</span>
    <span>iCloud Sync</span><span class="trust-dot">•</span>
    <span>Free to download · No account required</span>
  </div>
</div>'''
    text = insert_before_once(text, "<!-- BUILT FOR SECTION -->", trust, "WEBSITE REFRESH TRUST STRIP")

    release = '''<!-- WEBSITE REFRESH 2.4 RELEASE -->
<section class="release-section" aria-labelledby="release-24-heading">
  <div class="release-inner">
    <div class="release-kicker">Version 2.4.0</div>
    <h2 class="release-title" id="release-24-heading">A bigger E85 experience.</h2>
    <p class="release-sub">85Blends 2.4.0 expands beyond blend math with glanceable station tools, community ethanol readings, referral rewards, and more ways to use Pro.</p>
    <div class="release-grid">
      <article class="release-card"><div class="tag">PRO</div><h3>Nearby E85 Widgets</h3><p>See nearby E85 stations from your Home Screen with Small, Medium, and Large widget layouts. Supported community ethanol readings can appear right in the widget.</p></article>
      <article class="release-card"><div class="tag">COMMUNITY</div><h3>Community Ethanol Reports</h3><p>Share the ethanol percentage you find at the pump and see recent community readings at supported stations—useful when seasonal E85 content changes.</p></article>
      <article class="release-card"><div class="tag">REWARDS</div><h3>Refer &amp; Earn</h3><p>Invite other drivers to 85Blends Pro. Every 5 successful paid referrals works toward a free month of Pro.</p></article>
      <article class="release-card"><div class="tag">PRO</div><h3>More Pro Plan Options</h3><p>Choose Monthly, 3 Months, or Annual billing, alongside a refreshed purchase, restore, and subscription experience.</p></article>
    </div>
    <div class="release-actions"><a class="primary" href="/whats-new.html">See everything in 2.4.0</a><a class="secondary" href="/features.html">Explore all features</a></div>
  </div>
</section>'''
    text = insert_before_once(text, '<section id="blend-calculator" class="blend-calc-section">', release, "WEBSITE REFRESH 2.4 RELEASE")

    # Add explicit billing options beneath the Free vs Pro table.
    if "85BLENDS PRO BILLING OPTIONS" not in text:
        start = text.find('<section class="plans-section"')
        if start == -1:
            raise RuntimeError("plans-section not found")
        close = text.find("</section>", start)
        if close == -1:
            raise RuntimeError("plans-section closing tag not found")
        billing = '''\n  <!-- 85BLENDS PRO BILLING OPTIONS -->
  <div class="plan-options" aria-label="85Blends Pro billing options">
    <div class="plan-option"><div class="plan-name">Monthly</div><div class="plan-price">$3.99</div><div class="plan-note">per month</div></div>
    <div class="plan-option"><div class="plan-name">3 Months</div><div class="plan-price">$9.99</div><div class="plan-note">billed every 3 months</div></div>
    <div class="plan-option best"><div class="plan-name">Annual · Best Value</div><div class="plan-price">$24.99</div><div class="plan-note">per year</div></div>
  </div>
  <p style="text-align:center;color:#64748B;font-size:12px;margin-top:12px;">Subscriptions are purchased and managed through the App Store.</p>\n'''
        text = text[:close] + billing + text[close:]

    partner = '''<!-- WEBSITE REFRESH PARTNERS -->
<section class="partner-section" aria-labelledby="partners-heading">
  <div class="partner-inner">
    <div style="text-align:center;margin-bottom:26px;"><div class="features-section-eyebrow">Partners &amp; Recommended Gear</div><h2 class="features-section-title" id="partners-heading">Built with the community.</h2></div>
    <a class="partner-card" href="https://rvpsupply.com" target="_blank" rel="noopener noreferrer">
      <picture><source srcset="assets/rvpsupply-logo.webp" type="image/webp"><img src="assets/rvpsupply-logo.png" alt="RVPSupply" loading="lazy" decoding="async"></picture>
      <div><h3>RVPSupply · Founding Supporter</h3><p>Automotive parts and enthusiast-focused gear from a supporter that helped 85Blends grow from an idea into a real app.</p></div>
      <div class="partner-cta">Visit RVPSupply →</div>
    </a>
    <p class="partner-note">Additional featured brands will be added only after partnerships are officially announced.</p>
  </div>
</section>'''
    text = insert_before_once(text, "<!-- FOUNDER STORY -->", partner, "WEBSITE REFRESH PARTNERS")
    return text


def add_features_refresh(text):
    text = text.replace(
        '        <tr><td>Station Finder</td><td><span class="pro-check">&#10003;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>',
        '        <tr><td>Station Finder</td><td><span class="pro-check">&#10003;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n'
        '        <tr><td>Community Prices</td><td><span class="pro-check">&#10003;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n'
        '        <tr><td>Community Ethanol Reports</td><td><span class="pro-check">&#10003;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>'
    )
    text = text.replace(
        '        <tr><td>Pro Stations Map</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n        <tr><td>Price Alerts</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>',
        '        <tr><td>Pro Stations Map</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n'
        '        <tr><td>Nearby E85 Home Screen Widgets</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n'
        '        <tr><td>Ad-Free Experience</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>\n'
        '        <tr><td>Price Alerts</td><td><span class="pro-dash">&#8212;</span></td><td><strong style="color:#92600A">Coming in 2.4.1</strong></td></tr>'
    )

    extra_css = '''
    /* 2.4 feature additions */
    .new24-section{padding:72px 80px;background:#0D1320;color:white}.new24-inner{max-width:1120px;margin:auto}.new24-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:28px}.new24-card{border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:24px;background:rgba(255,255,255,.055)}.new24-card .eyebrow{color:#F5A800;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.new24-card h3{font-size:18px;margin:8px 0}.new24-card p{font-size:14px;color:#AAB4C5;line-height:1.65}.pro-billing{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px auto 0;max-width:820px}.pro-billing>div{border:1px solid #E5E7EB;border-radius:12px;padding:16px;text-align:center;background:white}.pro-billing strong{display:block;font-size:22px;color:#0D1320}.pro-billing span{font-size:12px;color:#64748B}@media(max-width:800px){.new24-section{padding:56px 24px}.new24-grid,.pro-billing{grid-template-columns:1fr}}
'''
    if "2.4 feature additions" not in text:
        text = text.replace("</style>", extra_css + "\n  </style>", 1)

    block = '''<!-- 2.4 FEATURE ADDITIONS -->
<section class="new24-section" aria-labelledby="new24-heading">
  <div class="new24-inner">
    <div style="color:#F5A800;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;">New in 2.4.0</div>
    <h2 id="new24-heading" style="font-family:'Bebas Neue',sans-serif;font-size:44px;margin:8px 0 10px;">More than a blend calculator.</h2>
    <p style="max-width:720px;color:#AAB4C5;line-height:1.7;">Version 2.4.0 adds glanceable station information, community ethanol reports, referrals, expanded Pro choices, and improvements across reporting and subscription flows.</p>
    <div class="new24-grid">
      <article class="new24-card"><div class="eyebrow">Pro</div><h3>Nearby E85 Widgets</h3><p>Small, Medium, and Large Home Screen layouts put nearby E85 stations within a glance. Recent community ethanol readings can appear when available.</p></article>
      <article class="new24-card"><div class="eyebrow">Community</div><h3>Ethanol Content Reporting</h3><p>Submit the ethanol percentage you measure at the pump and view recent readings at supported stations.</p></article>
      <article class="new24-card"><div class="eyebrow">Community</div><h3>Smarter Price Reporting</h3><p>Clearer contribution prompts and station validation help keep community price information useful.</p></article>
      <article class="new24-card"><div class="eyebrow">Rewards</div><h3>Refer &amp; Earn</h3><p>Work toward a free month of Pro after every 5 successful paid Pro referrals.</p></article>
    </div>
  </div>
</section>'''
    text = insert_before_once(text, '<section class="pro-section">', block, "2.4 FEATURE ADDITIONS")

    if "FEATURE PAGE PRO BILLING" not in text:
        start = text.find('<section class="pro-section">')
        close = text.find("</section>", start)
        if start == -1 or close == -1:
            raise RuntimeError("pro-section not found")
        billing = '''\n    <!-- FEATURE PAGE PRO BILLING -->
    <div class="pro-billing" aria-label="85Blends Pro billing options">
      <div><strong>$3.99</strong><span>Monthly</span></div>
      <div><strong>$9.99</strong><span>Every 3 months</span></div>
      <div style="border-color:#F5A800"><strong>$24.99</strong><span>Annual · Best Value</span></div>
    </div>
    <p style="text-align:center;color:#64748B;font-size:12px;margin-top:10px">Subscriptions are purchased and managed through the App Store.</p>\n'''
        text = text[:close] + billing + text[close:]
    return text


def add_about_refresh(text):
    # Remove the unused founder-photo placeholder instead of shipping a fake/stock image.
    text = re.sub(
        r'\s*<!-- PHOTO PLACEHOLDER[^\n]*\n\s*<div class="photo-placeholder hidden-feature".*?<p class="photo-placeholder-caption">.*?</p>\s*</div>\s*',
        "\n",
        text,
        count=1,
        flags=re.S,
    )
    timeline_css = '''
    /* 85Blends journey timeline */
    .growth-timeline{margin:64px auto 0;max-width:900px}.growth-timeline h2{font-family:'Bebas Neue',sans-serif;font-size:40px;text-align:center;margin-bottom:10px}.growth-timeline>.sub{text-align:center;color:#64748B;margin-bottom:26px}.growth-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.growth-item{border:1.5px solid #E5E7EB;border-radius:14px;padding:20px;background:#fff}.growth-year{color:#F5A800;font-size:12px;font-weight:800;letter-spacing:.1em}.growth-item h3{font-size:16px;margin:7px 0}.growth-item p{font-size:13px;line-height:1.6;color:#64748B}@media(max-width:760px){.growth-grid{grid-template-columns:1fr}}
'''
    if "85Blends journey timeline" not in text:
        text = text.replace("</style>", timeline_css + "\n  </style>", 1)
    timeline = '''<!-- 85BLENDS JOURNEY TIMELINE -->
<section class="growth-timeline" aria-labelledby="growth-heading">
  <h2 id="growth-heading">From one E85 build to a growing community.</h2>
  <p class="sub">A few milestones from the first version to the 2.4 era.</p>
  <div class="growth-grid">
    <article class="growth-item"><div class="growth-year">2026</div><h3>85Blends Launches</h3><p>The first release brought blend calculations, station tools, a garage, fuel logs, and reminders into one iPhone app.</p></article>
    <article class="growth-item"><div class="growth-year">2026</div><h3>Trip Planner &amp; Cloud Sync</h3><p>Road-trip range planning, reserve targets, station stops, and iCloud-backed app data expanded the everyday toolkit.</p></article>
    <article class="growth-item"><div class="growth-year">2026</div><h3>Community Pricing</h3><p>Drivers gained a way to contribute station pricing so the map becomes more useful as the community participates.</p></article>
    <article class="growth-item"><div class="growth-year">500+</div><h3>Downloads</h3><p>85Blends crossed its first 500 downloads while continuing to grow through enthusiast communities and word of mouth.</p></article>
    <article class="growth-item"><div class="growth-year">2.4.0</div><h3>Widgets &amp; Ethanol Reports</h3><p>Nearby E85 Home Screen widgets and community-reported ethanol percentages make station information more useful at a glance.</p></article>
    <article class="growth-item"><div class="growth-year">NEXT</div><h3>Price Alerts</h3><p>2.4.1 is focused on bringing station price alerts to Pro while continuing technical cleanup and optimization.</p></article>
  </div>
</section>'''
    text = insert_before_once(text, "<!-- SPONSOR CARD", timeline, "85BLENDS JOURNEY TIMELINE")
    return text


def add_privacy_refresh(text):
    text = text.replace(
        "community-submitted station and price information",
        "community-submitted station, price, and ethanol-content information",
    )
    text = text.replace(
        "<h2>Community Pricing and station information</h2>",
        "<h2>Community pricing, ethanol reports, and station information</h2>",
    )
    text = text.replace(
        'fuel price reports ("Community Pricing").',
        'fuel price reports and ethanol-content reports (collectively, "Community Data").',
    )
    text = text.replace(
        "station and price information useful",
        "station, price, and ethanol-content information useful",
    )
    return text


def normalize_simple_footer(text):
    return text.replace(
        "<footer>© 2026 85Blends. All rights reserved.</footer>",
        "<footer>© 2026 JF Apps. 85Blends is a product of JF Apps. All rights reserved.</footer>",
    )


def make_base_page(title, description, canonical_path, body, extra_head="", extra_script=""):
    canonical = SITE + canonical_path
    org = json.dumps(ORG_SCHEMA, separators=(",", ":"))
    software = json.dumps(SOFTWARE_SCHEMA, separators=(",", ":"))
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{html.escape(title)}</title>
  <meta name="description" content="{html.escape(description, quote=True)}" />
  <link rel="canonical" href="{canonical}" />
  <link rel="icon" href="/assets/app-icon.png" />
  <link rel="apple-touch-icon" href="/assets/app-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="apple-itunes-app" content="app-id=6762037468" />
  <meta property="og:type" content="website" /><meta property="og:site_name" content="85Blends" />
  <meta property="og:title" content="{html.escape(title, quote=True)}" /><meta property="og:description" content="{html.escape(description, quote=True)}" />
  <meta property="og:url" content="{canonical}" /><meta property="og:image" content="{SITE}/assets/main-hero.png" />
  <meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="{html.escape(title, quote=True)}" />
  <meta name="twitter:description" content="{html.escape(description, quote=True)}" /><meta name="twitter:image" content="{SITE}/assets/main-hero.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
  <script type="application/ld+json">{org}</script>
  <script type="application/ld+json">{software}</script>
  {extra_head}
  <style>
    *{{box-sizing:border-box}} html{{scroll-behavior:smooth}} body{{margin:0;font-family:'DM Sans',sans-serif;color:#0F172A;background:#fff}} a{{color:inherit}}
    nav{{height:68px;padding:0 48px;background:rgba(13,19,32,.96);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:30;border-bottom:1px solid rgba(255,255,255,.08)}}
    .brand{{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff;font-weight:800;font-size:20px}}.brand img{{width:40px;height:40px;border-radius:9px}}.brand b{{color:#F5A800}}
    .navlinks{{display:flex;align-items:center;gap:24px}}.navlinks a{{text-decoration:none;color:#CBD5E1;font-size:14px;font-weight:700}}.navlinks a:hover{{color:white}}.navlinks .download{{background:#1F6FEB;color:white;padding:10px 14px;border-radius:9px}}
    .hero{{background:#0D1320;color:white;padding:78px 24px 68px;text-align:center}}.eyebrow{{color:#F5A800;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}}h1{{font-family:'Bebas Neue',sans-serif;font-size:clamp(48px,7vw,76px);line-height:.98;margin:12px 0}}.hero p{{max-width:720px;margin:0 auto;color:#AAB4C5;line-height:1.7}}
    main{{max-width:1120px;margin:0 auto;padding:64px 24px 80px}}h2{{font-family:'Bebas Neue',sans-serif;font-size:38px;margin:0 0 10px}}.lead{{color:#64748B;line-height:1.7}}
    footer{{background:#0D1320;color:#94A3B8;padding:32px 24px;text-align:center;font-size:13px}}footer a{{color:#CBD5E1;text-decoration:none;margin:0 7px}}footer a:hover{{color:white}}
    @media(max-width:760px){{nav{{padding:0 18px}}.navlinks a:not(.download){{display:none}}main{{padding-top:48px}}}}
  </style>
</head>
<body>
<nav><a class="brand" href="/"><img src="/assets/app-icon.png" alt="85Blends"><span><b>85</b>Blends</span></a><div class="navlinks"><a href="/features.html">Features</a><a href="/e85-calculator.html">Calculator</a><a href="/whats-new.html">What's New</a><a href="/about.html">About</a><a class="download" href="{APP_STORE}" target="_blank" rel="noopener">App Store</a></div></nav>
{body}
<footer>© 2026 JF Apps. 85Blends is a product of JF Apps. All rights reserved.<br><br><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/support.html">Support</a><a href="{INSTAGRAM}" target="_blank" rel="noopener">Instagram</a></footer>
{extra_script}
</body></html>'''


def write_calculator_page():
    title = "Free E85 Blend Calculator – Calculate E30, E50, E60 & E85 | 85Blends"
    desc = "Free browser-based E85 blend calculator. Enter tank size, current fuel, pump ethanol content, and your target blend to calculate gallons of E85 and gasoline to add."
    schema = {
        "@context": "https://schema.org", "@type": "WebApplication", "name": "85Blends Free E85 Blend Calculator",
        "url": f"{SITE}/e85-calculator.html", "applicationCategory": "UtilitiesApplication", "operatingSystem": "Any",
        "description": desc, "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
    }
    head = '<script type="application/ld+json">' + json.dumps(schema, separators=(",", ":")) + '</script>'
    body = '''
<section class="hero"><div class="eyebrow">Free E85 Blend Calculator</div><h1>Hit your target blend.</h1><p>Calculate how much high-ethanol fuel and gasoline to add when filling the tank. Use the ethanol percentages shown on the pump—or measured values—when available.</p></section>
<main>
  <section class="calc-wrap">
    <div class="calc-head"><div><h2>Blend Calculator</h2><p class="lead">This calculator assumes you're filling the tank to the capacity entered below.</p></div><div class="formula-badge">E30 · E50 · E60 · E85 · Custom</div></div>
    <div class="calc-grid">
      <label>Tank capacity <span><input id="tank" type="number" min="1" step="0.1" value="18.5"> gal</span></label>
      <label>Fuel currently in tank <span><input id="currentGallons" type="number" min="0" step="0.1" value="5"> gal</span></label>
      <label>Current ethanol <span><input id="currentE" type="number" min="0" max="100" step="1" value="10"> %</span></label>
      <label>Target ethanol <span><input id="targetE" type="number" min="0" max="100" step="1" value="60"> %</span></label>
      <label>High-ethanol pump fuel <span><input id="e85E" type="number" min="0" max="100" step="1" value="70"> %</span></label>
      <label>Gasoline pump fuel <span><input id="gasE" type="number" min="0" max="100" step="1" value="10"> %</span></label>
    </div>
    <div class="preset-row" aria-label="Target blend presets"><button data-target="30">E30</button><button data-target="50">E50</button><button data-target="60" class="active">E60</button><button data-target="70">E70</button><button data-target="85">E85</button></div>
    <button class="calc-btn" id="calculate">Calculate Blend</button>
    <div class="result" id="result" aria-live="polite"><div class="result-title">Your fill</div><div class="result-grid"><div><span>High-ethanol fuel</span><strong id="e85Gallons">—</strong></div><div><span>Gasoline</span><strong id="gasGallons">—</strong></div><div><span>Final volume</span><strong id="finalGallons">—</strong></div><div><span>Expected blend</span><strong id="finalE">—</strong></div></div><p id="resultNote"></p></div>
  </section>
  <section class="info-grid"><article><h3>Why pump percentages matter</h3><p>E85 sold in the U.S. can vary by season and geography. Regular gasoline commonly contains ethanol too, so entering E10 instead of assuming E0 can materially change the result.</p></article><article><h3>Use measured data when you have it</h3><p>If you have a flex-fuel sensor or test the fuel at the pump, use that measured percentage for more accurate blend math.</p></article><article><h3>Know what your vehicle supports</h3><p>This tool calculates a fuel mixture; it does not determine whether that mixture is approved or safe for your vehicle. Follow manufacturer or tuner guidance.</p></article></section>
  <section class="app-cta"><div><div class="eyebrow">Want this saved to your vehicle?</div><h2>Take the calculator to the pump.</h2><p>85Blends for iPhone adds saved vehicle defaults, At The Pump partial-fill guidance, station discovery, fuel logs, community data, and more.</p></div><a href="https://apps.apple.com/us/app/85blends/id6762037468" target="_blank" rel="noopener">Open 85Blends on the App Store →</a></section>
</main>
<style>
.calc-wrap{border:1.5px solid #E5E7EB;border-radius:20px;padding:28px;box-shadow:0 14px 44px rgba(15,23,42,.06)}.calc-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.formula-badge{background:#FFF8E7;color:#92600A;border:1px solid #FFD980;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800}.calc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:24px}.calc-grid label{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid #E5E7EB;border-radius:12px;padding:14px;font-size:13px;font-weight:800;color:#334155}.calc-grid span{white-space:nowrap;color:#64748B}.calc-grid input{width:82px;padding:8px;border:1px solid #CBD5E1;border-radius:8px;font:inherit;text-align:right;color:#0F172A}.preset-row{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.preset-row button{border:1px solid #CBD5E1;background:white;border-radius:9px;padding:9px 13px;font-weight:800;cursor:pointer}.preset-row button.active{background:#0D1320;color:white;border-color:#0D1320}.calc-btn{width:100%;border:0;background:#1F6FEB;color:white;font:inherit;font-weight:800;padding:14px;border-radius:11px;cursor:pointer}.result{margin-top:18px;background:#0D1320;color:white;border-radius:16px;padding:22px}.result-title{color:#F5A800;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.1em}.result-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}.result-grid div{background:rgba(255,255,255,.06);border-radius:11px;padding:14px}.result-grid span{display:block;color:#94A3B8;font-size:11px}.result-grid strong{display:block;font-size:20px;margin-top:4px}.result p{color:#CBD5E1;font-size:13px;line-height:1.6;margin:14px 0 0}.info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:42px}.info-grid article{border:1px solid #E5E7EB;border-radius:14px;padding:20px}.info-grid h3{margin:0 0 7px;font-size:16px}.info-grid p{margin:0;color:#64748B;line-height:1.65;font-size:13px}.app-cta{margin-top:42px;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:18px;padding:26px;display:flex;align-items:center;justify-content:space-between;gap:24px}.app-cta h2{margin-top:7px}.app-cta p{max-width:650px;color:#64748B;line-height:1.6}.app-cta a{background:#F5A800;color:#0D1320;text-decoration:none;font-weight:800;padding:13px 16px;border-radius:10px;white-space:nowrap}@media(max-width:760px){.calc-head,.app-cta{display:block}.formula-badge{display:inline-block;margin-top:10px}.calc-grid,.result-grid,.info-grid{grid-template-columns:1fr}.app-cta a{display:inline-block;margin-top:10px;white-space:normal}}
</style>'''
    script = '''<script>
const n=id=>Number(document.getElementById(id).value);const out=(id,v)=>document.getElementById(id).textContent=v;
function calculate(){const T=n('tank'),C=n('currentGallons'),Ec=n('currentE')/100,Et=n('targetE')/100,Ee=n('e85E')/100,Eg=n('gasE')/100,note=document.getElementById('resultNote');if(![T,C,Ec,Et,Ee,Eg].every(Number.isFinite)||T<=0||C<0||C>T||Ee===Eg){note.textContent='Check your inputs. Tank capacity must be greater than zero, current gallons cannot exceed tank capacity, and the two pump fuels need different ethanol percentages.';['e85Gallons','gasGallons','finalGallons','finalE'].forEach(id=>out(id,'—'));return;}const fill=T-C;const high=(T*Et-C*Ec-fill*Eg)/(Ee-Eg);const gas=fill-high;if(high<-0.001||gas<-0.001){note.textContent='That target cannot be reached by filling to the entered tank capacity with these two pump fuels. Change the target, current fuel amount, or pump ethanol percentages.';['e85Gallons','gasGallons','finalGallons','finalE'].forEach(id=>out(id,'—'));return;}const h=Math.max(0,high),g=Math.max(0,gas),actual=(C*Ec+h*Ee+g*Eg)/T*100;out('e85Gallons',h.toFixed(2)+' gal');out('gasGallons',g.toFixed(2)+' gal');out('finalGallons',T.toFixed(2)+' gal');out('finalE','E'+actual.toFixed(1));note.textContent='Planning estimate only. Pump fuel can vary; use measured ethanol content when available and follow your vehicle manufacturer or tuner requirements.';}
document.getElementById('calculate').addEventListener('click',calculate);document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-target]').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById('targetE').value=b.dataset.target;calculate();}));calculate();
</script>'''
    write("e85-calculator.html", make_base_page(title, desc, "/e85-calculator.html", body, head, script))


def write_whats_new_page():
    title = "What's New in 85Blends – Version 2.4.0"
    desc = "See what's new in 85Blends 2.4.0, including Nearby E85 widgets, community ethanol reports, smarter price reporting, referral rewards, and expanded Pro plans."
    body = '''
<section class="hero"><div class="eyebrow">85Blends Release Notes</div><h1>What's new in 2.4.0</h1><p>Version 2.4.0 makes station information more useful at a glance, expands community contributions, and adds more flexibility for 85Blends Pro.</p></section>
<main>
  <section class="release-list">
    <article><div class="icon">📍</div><div><h3>New Nearby E85 Widget</h3><p>See nearby E85 stations right from your Home Screen with Small, Medium, and Large layouts.</p></div></article>
    <article><div class="icon">🧪</div><div><h3>Community Ethanol Reports</h3><p>Share the ethanol percentage you find at the pump and see recent community readings at supported stations.</p></div></article>
    <article><div class="icon">⛽</div><div><h3>Smarter Community Price Reporting</h3><p>Reporting an E85 price is faster and clearer, with improved post-trip prompts and station validation.</p></div></article>
    <article><div class="icon">🎁</div><div><h3>Referral Rewards</h3><p>Invite other drivers to 85Blends Pro and work toward a free month of Pro with every 5 successful paid referrals.</p></div></article>
    <article><div class="icon">⭐</div><div><h3>More Pro Plan Options</h3><p>Choose Monthly ($3.99), 3 Months ($9.99), or Annual ($24.99) billing.</p></div></article>
    <article><div class="icon">✨</div><div><h3>Improved Pro Experience</h3><p>A refreshed upgrade and subscriber experience makes managing Pro, restoring purchases, and accessing benefits easier.</p></div></article>
    <article><div class="icon">⚙️</div><div><h3>Refreshed More &amp; Settings</h3><p>Important Pro, referral, preference, help, and support options are easier to find.</p></div></article>
    <article><div class="icon">💬</div><div><h3>Review &amp; Share 85Blends</h3><p>Easier ways to leave App Store feedback and share 85Blends with other E85 drivers.</p></div></article>
    <article><div class="icon">🗺️</div><div><h3>Widget &amp; UI Polish</h3><p>Improved widget layouts, map presentation, ethanol displays, and how quickly your Pro status updates.</p></div></article>
    <article><div class="icon">🛠️</div><div><h3>Bug Fixes &amp; Reliability</h3><p>Improvements across station reporting, referrals, subscriptions, navigation, and general app stability.</p></div></article>
  </section>
  <section class="next-card"><div><div class="eyebrow">Next: 2.4.1</div><h2>Price Alerts are the next major goal.</h2><p>Technical cleanup and optimization come first, followed by Pro station price alerts. Until then, the website will label Price Alerts as coming in 2.4.1 rather than an already-live feature.</p></div><a href="/features.html">Explore current features →</a></section>
</main>
<style>.release-list{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.release-list article{border:1.5px solid #E5E7EB;border-radius:15px;padding:20px;display:flex;gap:14px}.release-list .icon{width:42px;height:42px;display:grid;place-items:center;background:#F8FAFC;border-radius:11px;font-size:20px;flex:0 0 auto}.release-list h3{font-size:16px;margin:0 0 6px}.release-list p{font-size:13px;color:#64748B;line-height:1.65;margin:0}.next-card{margin-top:34px;border-radius:18px;background:#0D1320;color:white;padding:26px;display:flex;justify-content:space-between;align-items:center;gap:24px}.next-card h2{margin-top:8px}.next-card p{color:#AAB4C5;max-width:720px;line-height:1.65}.next-card a{background:#F5A800;color:#0D1320;text-decoration:none;font-weight:800;padding:12px 15px;border-radius:10px;white-space:nowrap}@media(max-width:760px){.release-list{grid-template-columns:1fr}.next-card{display:block}.next-card a{display:inline-block;margin-top:10px;white-space:normal}}</style>'''
    write("whats-new.html", make_base_page(title, desc, "/whats-new.html", body))


def write_search_files():
    urls = ["/", "/features.html", "/e85-calculator.html", "/whats-new.html", "/about.html", "/support.html", "/privacy.html", "/terms.html"]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in urls:
        priority = "1.0" if url == "/" else ("0.9" if url in ("/features.html", "/e85-calculator.html") else "0.7")
        sitemap.append(f"  <url><loc>{SITE}{url}</loc><changefreq>weekly</changefreq><priority>{priority}</priority></url>")
    sitemap.append("</urlset>")
    write("sitemap.xml", "\n".join(sitemap) + "\n")
    write("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
    manifest = {
        "name": "85Blends",
        "short_name": "85Blends",
        "description": "E85 blend calculator, station finder, trip planner, and flex-fuel utility.",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#0D1320",
        "theme_color": "#0D1320",
        "icons": [{"src": "/assets/app-icon.png", "sizes": "1024x1024", "type": "image/png"}],
    }
    write("site.webmanifest", json.dumps(manifest, indent=2) + "\n")


def main():
    for name, (path, title, desc) in PAGES.items():
        text = read(name)
        if name == "index.html":
            text = add_index_refresh(text)
        elif name == "features.html":
            text = add_features_refresh(text)
        elif name == "about.html":
            text = add_about_refresh(text)
        elif name == "privacy.html":
            text = add_privacy_refresh(text)
        if name in ("support.html", "privacy.html", "terms.html"):
            text = normalize_simple_footer(text)
        text = enhance_footer_links(text)
        text = add_head_metadata(text, path, title, desc)
        write(name, text)
    write_calculator_page()
    write_whats_new_page()
    write_search_files()

    # Guardrails: fail the workflow rather than committing a half-applied refresh.
    index = read("index.html")
    features = read("features.html")
    privacy = read("privacy.html")
    checks = {
        "index educational E10 correction": "regular pump gasoline is commonly E10 rather than E0" in index,
        "index 2.4 section": "WEBSITE REFRESH 2.4 RELEASE" in index,
        "index price alerts staged": "Coming in 2.4.1" in index,
        "features 2.4 section": "2.4 FEATURE ADDITIONS" in features,
        "features widgets": "Nearby E85 Home Screen Widgets" in features,
        "privacy ethanol reports": "ethanol-content" in privacy,
        "calculator page": (ROOT / "e85-calculator.html").exists(),
        "what's new page": (ROOT / "whats-new.html").exists(),
        "sitemap": (ROOT / "sitemap.xml").exists(),
        "robots": (ROOT / "robots.txt").exists(),
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise SystemExit("Refresh validation failed: " + ", ".join(failed))
    print("Website refresh generated successfully")
    for name in checks:
        print("  OK:", name)


if __name__ == "__main__":
    main()
