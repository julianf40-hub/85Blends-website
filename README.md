# 85Blends website

Static website for [85blends.app](https://85blends.app), deployed from `main` with GitHub Pages.

## Local preview

Run `python3 -m http.server 4173 --bind 127.0.0.1` from this directory and open http://127.0.0.1:4173.

## Shared design and behavior

- `assets/site.css`: palette, typography, layout, responsive navigation, forms, and reduced-motion handling.
- `assets/site.js`: disclosure navigation, download bar, and calculator UI.
- `assets/fuel-math.js`: dependency-free blend and cost calculations.
- The same semantic header/footer and pricing markup are used across pages. Legal document text is protected by a comparison check.
- 2.4.0 additions are explicitly previews while the U.S. public App Store listing remains at 2.3.2. Update availability copy only after verifying the public release; do not change app release state from this repo.

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
