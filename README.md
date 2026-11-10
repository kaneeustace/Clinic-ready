# Clinic Ready: Behavioral Health Website + EHR

This repo has two parts:

1. **A public website** for an outpatient behavioral health clinic. It's static HTML/CSS/JS in the repo root.
2. **An EHR** (electronic health record) in `ehr/`. It's a Node.js + SQLite app that also serves the website and receives the website's appointment requests.

> ⚠️ **Demo/prototype. Do not enter real patient information yet.** The EHR follows HIPAA-minded practices: role-based access, audit logging, session timeouts, CSRF protection, no-store caching and e-signatures. Software alone doesn't make an organization HIPAA compliant, though. See [Before using real PHI](#before-using-real-phi).

## Quick start

```sh
cd ehr
npm install
npm run seed      # creates ehr/data/ehr.sqlite with demo staff + synthetic patients
npm start         # http://localhost:3000 (site)  ·  http://localhost:3000/ehr (EHR)
npm test          # 97 tests
```

Requires Node.js 22.5 or newer, which has SQLite built in. There's no build step, and the only dependency is Express.

Demo logins all use the password `Demo-Password-2026!`:

| Role | Email | Can |
|---|---|---|
| Admin | admin@example.com | Everything, plus user management, the audit log and the fee schedule |
| Clinician | therapist@example.com, counselor@example.com, prescriber@example.com | Charts, notes, treatment plans, measures, scheduling; view billing |
| Front desk | frontdesk@example.com | Patients (non-clinical), scheduling, website requests; view billing |
| Billing | billing@example.com | Patients (non-clinical), charges, payments, superbills |

## Deploy (always-on link)

**Render (can be done from a phone):**
1. Sign in at render.com with GitHub. Choose **New → Blueprint** and pick this repo and branch. Render reads `render.yaml`.
2. When asked, enter `EHR_ADMIN_EMAIL` (your email) and `EHR_ADMIN_PASSWORD`. The password needs 12+ characters and 3 of: lowercase, uppercase, number, symbol.
3. Deploy. Open `https://<your-app>.onrender.com/ehr` and sign in.
4. Create your staff accounts under **Admin → Users**. Then delete `EHR_ADMIN_PASSWORD` from the Render environment settings; it's only used on first boot.

The blueprint uses a paid instance with a 1 GB persistent disk (the free tier would erase the database on every restart). Production mode creates **no demo accounts or demo data**. To deploy a throwaway demo instead, add `EHR_DEMO=1`.

**Anywhere else:** use the root `Dockerfile` (mount a volume at `/var/data`). It's the same setup.

## Website

| File | Page |
|---|---|
| `index.html` | Home |
| `services.html` | Therapy, psychiatry, family, teens, groups, telehealth, conditions |
| `approach.html` | Our approach / about |
| `team.html` | Clinician profiles (placeholders) |
| `insurance.html` | Insurance, self-pay rates, Good Faith Estimate |
| `new-patients.html` | First-visit guide + FAQ |
| `contact.html` | Contact info and appointment request form (posts to `/api/appointment-requests`) |
| `crisis.html` | Crisis resources (988 etc.) |
| `privacy.html` | Website privacy, NPP summary, nondiscrimination, accessibility |

The crisis bar, header and footer are copied into every page. If you change one, change it on every page.

## EHR features

- **Patients & chart:** search, demographics, contacts, insurance, allergies, medications, ICD-10 problem list (with common behavioral health codes), and duplicate detection.
- **Scheduling:** week and day calendars per clinician, conflict detection, recurring weekly series, check-in/complete/no-show/cancel with reasons, and telehealth links.
- **Clinical notes:** intake, progress (DAP/SOAP), psychiatry, contact, discharge and psychotherapy notes.
  - Psychotherapy notes are visible only to their author.
  - Notes have structured MSE and risk assessment, and are validated before signing.
  - Signing requires re-entering your password, and signed notes can't be changed; corrections go in addenda.
- **Treatment plans:** problems, goals, objectives and interventions, with draft → active → superseded/completed and review dates.
- **Patient pictures:** a Pictures tab on every chart for a profile photo (shown in the chart banner for identification), photo ID, insurance cards and other images. Pictures are resized and stripped of location data in the browser, stored in the encrypted-backup database, served only to signed-in staff, and every view/upload/delete is audited.
- **Measurement-based care:**
  - PHQ-9 and GAD-7 with exact scoring and severity bands.
  - Trend charts with response/remission indicators.
  - PHQ-9 item-9 safety flags show on the chart header and the dashboard.
- **Billing:**
  - Fee schedule (CPT), charges from completed visits, and a work queue of visits that haven't been charged.
  - Claim status workflow, payments and adjustments, and a patient ledger with a running balance.
  - Printable superbills.
- **Website intake:**
  - The contact form posts to `/api/appointment-requests`, which has a honeypot and a rate limit.
  - Staff work the requests from an inbox, can see duplicate matches, and can convert a request to a patient in one click.
- **Admin & security:**
  - Users and roles, password policy and lockout, and password resets.
  - Audit log viewer with CSV export.
  - Per-patient access reports (an accounting of disclosures).
  - Idle session timeout (30 min) and CSRF tokens.
  - Strict CSP and security headers, plus `Cache-Control: no-store` on all EHR pages.

### Code layout

```
ehr/
  server.js            entry point (PORT, EHR_DB_PATH, EHR_TZ, TRUST_PROXY, NODE_ENV)
  src/app.js           express app, security headers, site + EHR + API mounting
  src/schema.sql       database schema
  src/auth.js          scrypt passwords, sessions, CSRF, login/logout, requirePerm
  src/permissions.js   role → permission map
  src/audit.js         audit(req, action, entity, id, patientId)
  src/views.js         escaping html`` templates, layout, chart header, formatters
  src/routes/*.js      feature modules (patients, schedule, notes, clinical, billing, requests, admin, dashboard)
  src/seeds/*.js       synthetic demo data per module
  public/              EHR CSS/JS
  test/                node:test suites (npm test)
```

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `EHR_DB_PATH` | `ehr/data/ehr.sqlite` | Database file |
| `EHR_TZ` | `America/New_York` | Clinic time zone for dates and schedules |
| `EHR_IDLE_MINUTES` | 30 | Idle sign-out |
| `NODE_ENV=production` | | Secure cookies + HSTS |
| `TRUST_PROXY` | | Set (e.g. `1`) behind a reverse proxy so client IPs and HTTPS are detected |

## Before using real PHI

These are organizational and infrastructure steps, not code:

- [ ] Host on HIPAA-eligible infrastructure under a signed **BAA**, with encryption at rest (encrypted disk or volume) and TLS everywhere.
- [ ] Run behind HTTPS with `NODE_ENV=production` and `TRUST_PROXY` set. Back up the database encrypted, and test restores.
- [ ] Complete a HIPAA **security risk assessment** and written policies: access, workforce training, incident response, retention.
- [ ] Add **multi-factor authentication** for staff, which isn't built in yet.
- [ ] Have counsel review consent forms, the NPP, 42 CFR Part 2 handling (substance use records) and minors' consent rules for your state.
- [ ] Have someone outside the team do a security review and a penetration test.
- [ ] For claims, connect a clearinghouse (837/835) or export superbills. Electronic claims aren't included.
- [ ] Remove the demo banner and seed accounts.

## Website launch checklist

- [ ] Replace every `[placeholder]`, `$[amount]`, the address, the phone number `(555) 010-0123` and `hello@example.com`.
- [ ] Replace the sample clinician profiles in `team.html` with real bios and photos.
- [ ] Replace the homepage stats with real figures, or remove them.
- [ ] Have legal/compliance counsel review `privacy.html` and the Good Faith Estimate language.
- [ ] Add your county crisis line on `crisis.html`.
- [ ] Don't add tracking pixels to pages with health-related forms (see HHS guidance on online tracking).
