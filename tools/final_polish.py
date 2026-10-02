from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(name, replacements):
    path = ROOT / name
    text = path.read_text(encoding="utf-8")
    for old, new in replacements:
        if old not in text:
            raise SystemExit(f"Expected text not found in {name}: {old[:100]!r}")
        text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")


# Fix a pre-existing malformed closing body tag across the legacy pages.
for name in ["index.html", "about.html", "support.html", "privacy.html", "terms.html"]:
    path = ROOT / name
    text = path.read_text(encoding="utf-8")
    if "</body>>" not in text:
        raise SystemExit(f"Expected malformed body tag not found in {name}")
    path.write_text(text.replace("</body>>", "</body>"), encoding="utf-8")

patch("index.html", [
    (
        '      <div class="faq-answer">It depends on your tank size and current ethanol level. As a rough guide, for a full tank of regular gas, you typically need to replace about 35–40% of the tank with E85 to reach E30. 85Blends calculates the exact gallons for your specific situation.</div>',
        '      <div class="faq-answer">There is no single percentage that works for every fill-up because the answer depends on tank size, how much fuel is already in the tank, the ethanol percentage already in that fuel, and the actual ethanol content of both pump fuels. Use the 85Blends calculator for the gallons required by your specific inputs.</div>'
    ),
    (
        '        <tr><td>Unlimited Vehicles</td><td><span class="plans-dash">—</span></td><td><span class="plans-pro-check">✓</span></td></tr>',
        '        <tr><td>Vehicle Garage</td><td>1 vehicle</td><td><strong>Unlimited</strong></td></tr>'
    ),
])

patch("features.html", [
    (
        '        <tr><td>Unlimited Vehicles</td><td><span class="pro-dash">&#8212;</span></td><td><span class="pro-gold">&#10003;</span></td></tr>',
        '        <tr><td>Vehicle Garage</td><td>1 vehicle</td><td><strong>Unlimited</strong></td></tr>'
    ),
    (
        '<h2 class="feat-title">All your vehicles, organized.</h2>',
        '<h2 class="feat-title">Your vehicles, organized.</h2>'
    ),
    (
        '<p class="feat-desc">Store vehicle profiles with tank size, octane targets, odometer, and preferred ethanol levels — ready when you fuel up.</p>',
        '<p class="feat-desc">Store vehicle profiles with tank size, octane targets, odometer, and preferred ethanol levels — ready when you fuel up. Free includes one vehicle; Pro unlocks unlimited vehicles.</p>'
    ),
    (
        '<ul class="feat-list"><li>Multiple vehicle profiles</li><li>Per-vehicle ethanol targets</li><li>Tank size and octane stored</li><li>Odometer and service tracking</li></ul>',
        '<ul class="feat-list"><li>1 vehicle on Free · Unlimited with Pro</li><li>Per-vehicle ethanol targets</li><li>Tank size and octane stored</li><li>Odometer and service tracking</li></ul>'
    ),
])

# Make the default calculator example reachable: 2 gal E10 + E70/E10 fill can reach E60.
patch("e85-calculator.html", [
    ('id="currentGallons" type="number" min="0" step="0.1" value="5"', 'id="currentGallons" type="number" min="0" step="0.1" value="2"'),
])

patch("privacy.html", [
    ('<p class="updated">Last updated: September 4, 2026</p>', '<p class="updated">Last updated: October 2, 2026</p>'),
    (
        '<p>85Blends lets users submit or update community station details and fuel price reports and ethanol-content reports (collectively, "Community Data"). When you submit a report, we store the station details, price, fuel type, timestamp, and a persisted anonymous reporter/device identifier used to help prevent abuse and maintain the accuracy of community data. This identifier is generated on your device, is not your name, email address, or Apple ID, and is not used to advertise to you or to track you across other companies\' apps or websites. Community-submitted information may be displayed to other users to help keep station, price, and ethanol-content information useful. Community submissions and related station data are stored using Supabase, our backend database provider, which processes this information on our behalf.</p>',
        '<p>85Blends lets users submit or update community station details, fuel price reports, and ethanol-content reports (collectively, "Community Data"). Depending on the type of report, we may store station details, the submitted price and/or ethanol percentage, fuel type where applicable, timestamp, optional notes, app version, and a persisted anonymous reporter/device identifier used to help prevent abuse and maintain the accuracy of community data. This identifier is generated on your device, is not your name, email address, or Apple ID, and is not used to advertise to you or to track you across other companies\' apps or websites. Community-submitted information may be displayed to other users to help keep station, price, and ethanol-content information useful. Community submissions and related station data are stored using Supabase, our backend database provider, which processes this information on our behalf.</p>'
    ),
    (
        '<p>Community price reports and the persisted anonymous reporter/device identifier associated with them are stored using Supabase and are kept for as long as they remain useful to the Community Pricing feature — for example, until a report is superseded by a newer report for that station, the underlying station record is corrected or removed, or you ask us to delete it. We do not currently apply a fixed automatic deletion schedule to this data. You can email <a href="mailto:support@85blends.app">support@85blends.app</a> to request deletion or correction of a community price report, station entry, or other information associated with your device, and we will take reasonable steps to respond.</p>',
        '<p>Community price and ethanol-content reports, together with the persisted anonymous reporter/device identifier associated with them, are stored using Supabase and are kept for as long as they remain useful to the Community Data features — for example, until a report is superseded by newer information for that station, the underlying station record is corrected or removed, or you ask us to delete it. We do not currently apply a fixed automatic deletion schedule to this data. You can email <a href="mailto:support@85blends.app">support@85blends.app</a> to request deletion or correction of a community report, station entry, or other information associated with your device, and we will take reasonable steps to respond.</p>'
    ),
])

# Final assertions: no malformed body tags, no stale risky shortcuts, and the intended gating is explicit.
for path in ROOT.glob("*.html"):
    text = path.read_text(encoding="utf-8")
    assert "</body>>" not in text, f"Malformed body close remains in {path.name}"
    assert "<html" in text.lower() and "</html>" in text.lower(), f"HTML shell missing in {path.name}"

index = (ROOT / "index.html").read_text(encoding="utf-8")
features = (ROOT / "features.html").read_text(encoding="utf-8")
privacy = (ROOT / "privacy.html").read_text(encoding="utf-8")
calc = (ROOT / "e85-calculator.html").read_text(encoding="utf-8")
assert "35–40%" not in index
assert "Vehicle Garage</td><td>1 vehicle" in index
assert "Vehicle Garage</td><td>1 vehicle" in features
assert "Coming in 2.4.1" in index and "Coming in 2.4.1" in features
assert "value=\"2\"" in calc
assert "Last updated: October 2, 2026" in privacy
assert "ethanol-content reports" in privacy
print("Final website polish validation passed")
