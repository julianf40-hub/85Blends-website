# 85Blends website

Static website for [85blends.app](https://85blends.app), deployed from `main` with GitHub Pages.

## Local preview

Run `python3 -m http.server 4173 --bind 127.0.0.1` from this directory and open http://127.0.0.1:4173.

## Shared design and behavior

- `assets/site.css`: palette, typography, layout, responsive navigation, forms, and reduced-motion handling.
- `assets/site.js`: disclosure navigation, download bar, and calculator UI.
- `assets/fuel-math.js`: dependency-free blend and cost calculations.
- The same semantic header/footer and pricing markup are used across pages. Legal document text is protected by a comparison check.
- Public iPhone availability and Android development status must be kept separate. Check the current App Store for iOS version and offered subscriptions; avoid unverified static version claims.
- The Android page is a development preview only. There is no Google Play download URL or open public beta until launch/test readiness is confirmed. Device-tested features are derived from the separate `85Blends-Android` repository.
- The iPhone app imagery on other pages is genuine historical iOS imagery. Do not reuse it to portray Android screens; add official Android screenshots from a real app build before the Play listing goes live.
- The privacy policy and data-deletion instructions cover both platforms. Confirm the live HTTPS pages work before entering the URLs in Google Play Console.

## Checks

```sh
node --test tests/fuel-math.test.cjs
python3 tests/check-site.py
git diff --check
```

The legal preservation check compares against `origin/main`. These checks do not replace visual browser testing.

## Imagery

Focused calculator, stations, and pump images are genuine source screenshots from the earlier App Store asset work. Garage, fuel log, and reminders are focused crops of the existing website artwork; no app UI was generated or redrawn. Older example values are illustrative, not live station prices. RVPSupply uses the uploaded logo optimized in the earlier partner-card change.

To regenerate the focused assets, install Pillow and run:

```sh
python3 scripts/optimize-images.py --source-dir /path/to/original/screenshots
```

The input directory should contain `calculator-screen.png`, `stations-screen.png`, and `pump-instructions.png`. Fresh widget and ethanol-report screenshots remain a follow-up asset requirement. Trip Planner uses an explicitly labeled route illustration, not a fabricated app screenshot.
