# Visual audit implementation — October 2, 2026

The website has been refreshed across all eight pages. This checklist tracks the 32 visual findings without treating missing source images as completed work.

## Implemented

| Audit findings | Changes |
| --- | --- |
| 1–6 | One responsive header on every page; complementary desktop/menu breakpoints; complete dark mobile disclosure; small-phone Support overflow removed. |
| 7–9 | Shared palette and type hierarchy. Body copy starts at 16px, supporting text at 14px, form values at 16px, inputs at 48px high. Condensed type is reserved for short hero headlines. |
| 10–14 | Shorter homepage, stable CTA labels, three trust facts, compact audience chips, expandable ethanol guidance, and one combined product/release-preview story. |
| 16–20 | Genuine focused app images with enlarge links; baked-in website-button artwork removed from feature presentations; real pump result image; labeled Trip Planner route illustration; consistent image frames and feature jump links. |
| 21–24 | Cost per 100 miles is the primary comparison. Fill-up price is separate. Controls are grouped, presets fit, invalid inputs are rejected, unreachable targets show the available range, and empty metrics are hidden. |
| 25–26 | Shared current Free/Pro benefits and pricing layout; full comparison is expandable; planned features and billing options are marked separately. |
| 27–29 | Short founder excerpt on Home, one chronological About journey, no unverified download statistic, and real RVPSupply artwork on both pages. |
| 30 | Support action moved up; concise help topics added. Legal contents links and reading measure improved. Policy document text is unchanged. |
| 31 | Release-preview page leads with three major additions, contextual genuine station imagery, and a concise other-improvements list. Direct new-feature imagery is still tracked below. |
| 32 | Shared readable footer; mobile download bar is hidden during menu use and input editing, is dismissible, and has reserved page space. Desktop QR retained. |

## Remaining asset requirement — finding 15

Current screenshots of the actual Nearby E85 widget layouts and community ethanol-report UI were not available among the verified source assets. These still need to be supplied and visually checked before this imagery portion can be closed. The new release-page layout is ready to receive them. No app screen was fabricated.

Trip Planner currently uses a clearly labeled route illustration rather than a screenshot. A verified current screenshot would be a useful later replacement, but the audit's consistent-illustration alternative is implemented.

## Release-copy correction

The U.S. public App Store page and Apple's lookup endpoint both returned version 2.3.2 on October 2. Widgets, ethanol reports, referrals, and the additional billing choices are therefore marked as 2.4.0 previews. Price Alerts are marked as planned, not included. No App Store configuration or app-release state was modified.

Source: [85Blends on the App Store](https://apps.apple.com/us/app/85blends/id6762037468).

## Validation

- 32 page/viewport checks: all eight pages at widths 320, 390, 768, and 1440px. No horizontal document overflow; one navigation mode available at each size.
- Additional homepage checks at 820, 960, 1024, 1100, and 1101px confirm there is no missing-navigation interval.
- All eight mobile menus opened at 320 × 568; nine destinations/actions were present, the drawer fit, current-page markers were correct, and Escape closed the drawer.
- Desktop and phone visual views were captured for every page; focused checks covered feature imagery, RVPSupply, pricing, calculator success/unreachable/invalid states, and the download bar during editing/menu use.
- 12 calculator tests pass. Static checks pass for local links/anchors, single h1, unique IDs, image alt, structured-data validity, shared header/footer consistency, FAQ/schema consistency, and unchanged legal document text.
- Browser warning/error check returned none during the inspected local preview.

### Homepage length

| Width | Audited height | Revised height | Reduction |
| --- | ---: | ---: | ---: |
| 320px | 15,148px | 9,669px | 36.2% |
| 390px | approximately 13,670px | 8,872px | approximately 35.1% |
| 768px | 11,278px | 7,659px | 32.1% |
| 1440px | 9,129px | 6,489px | 28.9% |

These measurements reflect settled fonts and reserved image dimensions, with details closed. Features intentionally allocates more space to readable screenshots; it is not claimed to be shorter at every width.

### Selected palette contrast checks

| Text treatment | Foreground / background | Ratio |
| --- | --- | ---: |
| Secondary prose | #526176 / white | 6.31:1 |
| Light-section eyebrow | #865600 / #F4F7FB | 5.84:1 |
| Footer links | #CBD5E1 / #0D1320 | 12.50:1 |
| Dark supporting text | #BFCBDA / #0D1320 | 11.29:1 |
| Dark links | #90BAFF / #0D1320 | 9.42:1 |
| Blue-button text | white / #185DCC | 6.04:1 |

These are selected palette checks, not a full WCAG conformance certification.

## Limits

Testing used the browser's desktop and phone-sized viewports, not physical phones, an exhaustive screen-reader audit, or a cross-browser compatibility suite. App screens contain illustrative historical values, not live station prices. Fresh widget/report screenshots remain open as stated above.

The canonical iOS checkout and read-only synced project sources were not changed.

