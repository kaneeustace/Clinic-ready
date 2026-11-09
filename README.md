# Clinic Ready: Behavioral Health Website

A static website template for an outpatient behavioral health clinic offering therapy, psychiatry and telehealth. It's plain HTML, CSS and JS, so there's no build step.

## Pages

| File | Page |
|---|---|
| `index.html` | Home |
| `services.html` | Services (therapy, psychiatry, family, teens, groups, telehealth, conditions) |
| `approach.html` | Our Approach / About |
| `team.html` | Clinician profiles (placeholders) |
| `insurance.html` | Insurance, self-pay rates, Good Faith Estimate |
| `new-patients.html` | First-visit guide and FAQ |
| `contact.html` | Contact info and appointment request form |
| `crisis.html` | Crisis resources (988, etc.) |
| `privacy.html` | Website privacy, HIPAA NPP summary, nondiscrimination, accessibility |
| `404.html` | Not found |

Shared styles are in `assets/css/styles.css` and shared behavior is in `assets/js/main.js` (mobile nav, active link, scroll reveal, form validation).

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Before launch: checklist

- [ ] Replace every `[placeholder]`, `$[amount]`, the address, phone `(555) 010-0123` and `hello@example.com`.
- [ ] Replace the sample clinician profiles in `team.html` with real bios, credentials and photos.
- [ ] Replace the homepage stats with real figures, or remove them.
- [ ] **Connect the appointment form to a HIPAA-compliant form processor** that will sign a BAA. Until then it only shows a success message and doesn't send anything.
- [ ] Have legal/compliance counsel review `privacy.html` (NPP, nondiscrimination, Part 2) and the Good Faith Estimate language.
- [ ] Add a local/county crisis line on `crisis.html`.
- [ ] If you add analytics, avoid tracking pixels on pages with health-related forms (see HHS guidance on online tracking technologies).
- [ ] Run an accessibility check (axe / Lighthouse) and test with a keyboard and screen reader.

## Shared header/footer

The crisis bar, header and footer are copied into every page. If you change one, change it on every page, or move the site to a static site generator with includes (Eleventy, Astro, etc.).
