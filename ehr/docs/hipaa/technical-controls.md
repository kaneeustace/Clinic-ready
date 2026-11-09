# Technical Controls: Where They Live and How to Verify Them

> **TEMPLATE: REVIEW REQUIRED.** This maps the EHR's technical safeguards to the code and configuration in this repository and gives step-by-step checks to run against **production**. It is not legal advice. Controls marked **(implemented in this release; verify after deployment)** were added alongside this package by parallel work. Confirm their exact page paths, command names, and environment-variable formats against the deployed code and the root `README.md`. Anything marked **[verify]** is a detail the drafter could not confirm. Record each result in §6 of [risk-assessment.md](risk-assessment.md).

Conventions:
- `https://<ehr-host>` is your production URL, for example `https://clinic-ready.onrender.com` or your custom domain.
- Run browser checks in a private window. Never test with real patient data; use a test patient named "ZZTEST, Verification".
- Paths are relative to the repository root.

---

## 1. Transport security, headers, sessions (164.312(a)(2)(iii), (d), (e)(1))

| Control | Location |
|---|---|
| CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, Permissions-Policy, COOP | `ehr/src/app.js` `securityHeaders()` |
| HSTS (1 year, includeSubDomains) when `NODE_ENV=production` | `ehr/src/app.js` |
| `Cache-Control: no-store` + `Pragma: no-cache` on `/ehr` and `/api` | `ehr/src/app.js` `noStore()` |
| Cross-origin POST rejection | `ehr/src/app.js` `sameOrigin()` |
| Session cookie `ehr_sid`: HttpOnly, SameSite=Strict, Secure in production. The database stores only a SHA-256 hash of the token. | `ehr/src/auth.js` `createSession()`, `cookieAttrs()` |
| Idle timeout `EHR_IDLE_MINUTES` (default 30); absolute limit 12 h; hourly purge of expired sessions | `ehr/src/auth.js`, `ehr/server.js` |
| CSRF token on every state-changing EHR request | `ehr/src/auth.js` `csrfProtection` |
| `NODE_ENV=production`, `TRUST_PROXY=1` | `render.yaml`, `Dockerfile` |

**Verify:**
1. Run `curl -sI https://<ehr-host>/ehr/login`. You should see:
   - `strict-transport-security: max-age=31536000; includeSubDomains`
   - `content-security-policy: default-src 'self'; ...`
   - `x-frame-options: DENY`
   - `cache-control: no-store`
2. Run `curl -sI http://<ehr-host>/ehr/login`. It must redirect to HTTPS (Render does this by default) or refuse the connection. **[verify]**
3. Sign in. In browser dev tools (Application → Cookies), `ehr_sid` must show **HttpOnly ✓, Secure ✓, SameSite Strict**.
4. Idle test: sign in and leave the tab untouched for 31 minutes, then click a link. You must land on the sign-in page.
5. In the hosting dashboard, confirm `NODE_ENV=production` and `TRUST_PROXY=1`, and confirm `EHR_DEMO` is **absent**.
6. Run an SSL Labs test (https://www.ssllabs.com/ssltest/) against the host. Grade A expected.

## 2. Authentication and access control (164.312(a)(1), (a)(2)(i), (d); 164.308(a)(4))

| Control | Location |
|---|---|
| Unique user per email (`users.email UNIQUE`) | `ehr/src/schema.sql` |
| scrypt password hashing (N=16384, r=8, p=1, 64-byte key, random 16-byte salt); timing-safe compare; dummy hash for unknown emails | `ehr/src/auth.js` `hashPassword()`, `verifyPassword()` |
| Password policy: 12+ characters, 3 of 4 character classes | `ehr/src/auth.js` `passwordPolicyError()` |
| Lockout: 5 failures → 15-minute lock; `login_failed` / `login_locked` audited | `ehr/src/auth.js` (`MAX_FAILED`, `LOCK_MINUTES`) |
| Roles → permissions; `requirePerm()` middleware; `can()` requires `active = 1` | `ehr/src/permissions.js`, `ehr/src/auth.js` |
| Deactivate a user / reset a password → all their sessions revoked (audited with `sessions_revoked=n`) | `ehr/src/routes/admin.js` |
| Emergency access / admin recovery: `EHR_ADMIN_RESET=1` + `EHR_ADMIN_EMAIL` + `EHR_ADMIN_PASSWORD` on restart, audited as `admin_reset` | `ehr/src/bootstrap.js` |
| **TOTP two-factor sign-in** (implemented in this release; verify after deployment). Optional per user; enforced for all users when `EHR_REQUIRE_MFA=1`. Secret stored in `users.mfa_secret`, encrypted with `EHR_DATA_KEY`. One-time recovery codes stored only as SHA-256 hashes in `users.mfa_recovery`. A session stays `mfa_pending` until the second factor is verified. | `ehr/src/auth.js` [verify], `ehr/src/db.js` (columns), hosting environment |

**Verify:**
1. Sign in with a wrong password 5 times on a test account. The 6th attempt must say "Too many failed attempts". **Admin → Audit log** must show `login_failed` ×5 and `login_locked`. Unlock it from Admin → Users.
2. Signed in as a **billing** user, open `https://<ehr-host>/ehr/patients/<id>/notes`. Expect **403 Not permitted** and a `forbidden` audit entry.
3. Signed in as a **frontdesk** user, open `/ehr/admin`. Expect 403.
4. **MFA (this release):**
   1. As a test user, enroll from the account page (`/ehr/account` [verify exact enrollment path]) using an authenticator app. Sign out, then sign in again. A code must be requested after the password.
   2. Enter a wrong code. It must be rejected and audited [verify action name].
   3. Use one recovery code. A second use of the same code must fail.
   4. With `EHR_REQUIRE_MFA=1` set in the hosting dashboard and the service redeployed, a user who **hasn't** enrolled must be forced to enroll before reaching any patient data.
   5. Confirm the secret is encrypted at rest. From a Render shell (or a downloaded copy of the database on an encrypted machine), run `sqlite3 /var/data/ehr.sqlite "SELECT substr(mfa_secret,1,12) FROM users WHERE mfa_enabled=1 LIMIT 1;"`. The value must **not** be a plain base32 string (A–Z, 2–7). Expect a ciphertext or prefixed encoding [verify format].
   6. Confirm `EHR_DATA_KEY` is set as a secret and that a copy exists in the password manager and in escrow.
5. Confirm `EHR_ADMIN_PASSWORD` and `EHR_ADMIN_RESET` are **not** present in the production environment.
6. Confirm MFA is turned on for **every Render and GitHub account** with access to this service. This is outside the EHR, but those accounts can reach all of its data.

**Key rotation note:** `EHR_DATA_KEY` can't simply be swapped. Doing so makes existing TOTP secrets unreadable, and users would have to re-enroll. Follow the rotation procedure in the deployed README [verify]. If there isn't one, plan a rotation by resetting MFA for all users.

## 3. Audit controls and monitoring (164.312(b); 164.308(a)(1)(ii)(D))

| Control | Location |
|---|---|
| `audit(req, action, entityType, entityId, patientId, detail)` is called on every view or change of PHI, and also on login, logout, failed login, forbidden, sign, sign_failed, addendum, delete, export, password_reset, deactivate, setup, admin_reset, and blocked. `detail` is capped at 500 characters and must contain **no PHI** content. | `ehr/src/audit.js`, all `ehr/src/routes/*.js` |
| `audit_log` table (timestamp in UTC, user, action, entity, patient, IP, detail); indexes by patient and by user | `ehr/src/schema.sql` |
| Audit log viewer with filters; CSV export (with spreadsheet formula injection neutralized); the export itself is audited | `ehr/src/routes/admin.js` (`/ehr/admin/audit`, `/ehr/admin/audit.csv`) |
| Per-patient access report | `/ehr/admin/patients/:id/access-report` |
| **Tamper-evident append-only log** (implemented in this release; verify after deployment). Each row stores `prev_hash` and `hash`, so changing or deleting a row breaks the chain. | `ehr/src/db.js` columns; `ehr/src/audit.js` [verify] |
| **Automated security alerts** on `/ehr/security` (implemented in this release; verify after deployment). The `security_alerts` table has kinds such as `failed_logins`, `bulk_access`, `after_hours`, `audit_chain_broken`, `backup_failed`; severity; and an open → acknowledged → resolved workflow with a resolution note. | `ehr/src/routes/security.js`, `ehr/src/schema.sql` |

**Verify:**
1. View the test patient's chart. In **Admin → Audit log**, filter by that MRN. A `view` / `patient` row must appear with your user name, IP, and time.
2. Open the access report for the test patient. Your view must be listed.
3. Export the CSV. A new `export` / `audit_log` row must appear.
4. **Chain (this release):** On `/ehr/security` [verify], run or view the chain verification. It must report the chain intact. On a **copy** of the database in a non-production environment, edit any older `audit_log.detail` value, then run verification. It must report `audit_chain_broken`. Never tamper with production.
5. **Alerts (this release):** Trigger 5+ failed logins on a test account. A `failed_logins` alert must appear on `/ehr/security`. Acknowledge it and resolve it with a note.
6. Confirm the IP column shows real client IPs, not Render's proxy address. If it shows proxy addresses, `TRUST_PROXY` is wrong.
7. Look through Render's service logs for a day. They must contain **no** patient names, DOBs, or note text (Render requires this). Report any PHI to the developer as a high-priority fix.

## 4. Backups and contingency (164.308(a)(7); 164.310(d)(2)(iv))

| Control | Location |
|---|---|
| SQLite database on a persistent disk: `EHR_DB_PATH=/var/data/ehr.sqlite`, disk `ehr-data` at `/var/data` | `render.yaml`, `Dockerfile` (`VOLUME /var/data`) |
| WAL journal mode | `ehr/src/db.js` |
| Render daily disk snapshots (covered and encrypted in a HIPAA workspace, per Render docs) | Render dashboard → service → Disks |
| **Encrypted automated backups** (implemented in this release; verify after deployment). AES-256-GCM with `EHR_BACKUP_KEY`; scheduled; each backup verified after it's written; retention pruning; failures raise a `backup_failed` security alert; restore from the command line. | `ehr/src/routes/backups.js` and backup module/CLI [verify paths and command names in README] |
| Health check `/healthz` | `ehr/src/app.js`, `render.yaml`, `Dockerfile` |

**Verify:**
1. **Persistent disk:** In Render, open Service → Disks and confirm `ehr-data` is mounted at `/var/data`. Create the test patient, **restart** the service, and confirm the patient is still there.
2. In the hosting environment, confirm `EHR_BACKUP_KEY` is set as a secret and differs from `EHR_DATA_KEY`. Confirm copies exist in the password manager and in escrow.
3. Open the backups page [verify path, for example `/ehr/admin/backups`]. Confirm the latest backup has a recent timestamp and a "verified" status, and that retention is what policy says: `[N daily / N weekly / N monthly]`.
4. Confirm the backup file is **not** readable SQLite: `head -c 16 <backupfile>` must **not** show `SQLite format 3`.
5. **Restore test (quarterly):**
   1. Copy a backup to a **non-production** machine or service that is also under a BAA, or to an encrypted workstation.
   2. Run the CLI restore [verify command, for example `node src/backup.js restore <file>`] with `EHR_BACKUP_KEY` set.
   3. Start the app against the restored file and confirm the newest records exist.
   4. Record the date, the backup timestamp, the time the restore took, and the result.
   5. Securely delete the test copy.
6. Confirm the off-site copy exists at `[location]` and is less than `[24 h]` old.
7. Confirm a `backup_failed` alert appears on `/ehr/security` if a backup fails. Test this in non-production by giving it a bad key or path.

## 5. Patient right of access and accounting of disclosures (164.524, 164.528)

| Control | Location |
|---|---|
| **Record export for right of access** (implemented in this release; verify after deployment). Produces the designated record set for a patient in electronic form and **leaves out psychotherapy notes**. The export is audited. | `ehr/src/routes/records.js` [verify] |
| **Accounting of disclosures** (implemented in this release; verify after deployment). The `disclosures` table holds date, recipient, purpose, description, legal basis, linked ROI consent note, Part 2 flag, method, and who entered it. | `ehr/src/schema.sql`, `ehr/src/routes/records.js` [verify] |
| ROI / consent note type: direction, recipient, specific information, purpose, expiry, Part 2 flag, consent method, signer, revocation. Shows a Part 2 redisclosure notice when the Part 2 flag is set. | `ehr/src/routes/notes.js` (`roi` type, `roiNotice()`) |
| Per-patient access report (internal access) | `ehr/src/routes/admin.js` |

**Verify:**
1. For the test patient, create a signed progress note and a psychotherapy note. Generate the record export. The progress note must be included and the psychotherapy note must **not** be. An audit row must be written for the export.
2. Record a test disclosure with `basis = required_by_law`. The patient's accounting must list it. Record one with `basis = treatment`. Confirm how the accounting handles TPO disclosures, which HIPAA exempts from the accounting (164.528(a)(1)(i)) [verify the export's behavior matches policy].
3. Mark a disclosure `includes_part2`. Confirm the Part 2 redisclosure statement is presented [verify].

## 6. Integrity of clinical records (164.312(c))

| Control | Location |
|---|---|
| Drafts can be edited by their author only. Signing requires **re-entering the password**. Signed notes are immutable. Corrections are append-only **addenda**. Only drafts can be deleted, and only by their author. | `ehr/src/routes/notes.js` (`/notes/:id/sign`, `/notes/:id/addenda`, `/notes/:id/delete`) |
| Notes are validated before signing (required fields, MSE, risk) | `ehr/src/routes/notes.js` `signErrors()` |
| Treatment plans: draft → active → superseded/completed; signatures lock content; revisions create a new version | `ehr/src/routes/plans.js`, `ehr/docs/treatment-plan-spec.md` |
| **Psychotherapy notes visible only to their author, admins included.** They are excluded from chart note lists for everyone else, and access attempts are denied and audited. | `ehr/src/routes/notes.js` `canView()`, the list query `n.type <> 'psychotherapy' OR n.author_id = ?` |

**Verify:**
1. Clinician A writes a psychotherapy note for the test patient. Signed in as Clinician B, and then as Admin, open the patient's notes list. The note must not be listed. Opening `/ehr/notes/<id>` directly must return **403** with "Psychotherapy notes are private to the clinician who wrote them." A `forbidden` audit row must be written.
2. Sign a note. Confirm the edit link is gone and that a POST to `/ehr/notes/<id>/edit` is refused. Add an addendum and confirm it appears with your name and timestamp.
3. Try to sign with a wrong password. The attempt must fail and `sign_failed` must be audited.

## 7. Treatment-plan gate for ongoing-therapy notes

This isn't a HIPAA Security Rule requirement. It is a documentation-integrity control that supports payer and accreditation requirements (see `ehr/docs/treatment-plan-spec.md`). It's listed here so the practice can show auditors and payers that it is enforced.

| Control | Location |
|---|---|
| **Progress and group notes are blocked until the patient has an active, signed treatment plan.** `PLAN_REQUIRED_TYPES = ["progress", "group"]`. Creating such a note without an active plan returns **409** with "A signed, active treatment plan is required before progress or group notes can be written for this patient." The block is audited as `blocked` / `note`. The check is repeated when signing, so a draft can't be signed if the plan has lapsed. The chart's notes list shows a warning with a link to the treatment plan. | `ehr/src/routes/notes.js` (`PLAN_REQUIRED_TYPES`, `PLAN_REQUIRED_MSG`, `planRequiredFor()`, `planRequiredPage()`, the sign route); active plan = `treatment_plans.status = 'active'` (`ehr/src/routes/plans.js`) |

Intake, psychiatry, contact, crisis safety plan, ASAM, ROI, discharge, and psychotherapy notes are **not** gated, so assessment and crisis documentation can always be written.

**Verify:**
1. For a test patient with **no** active plan, open Notes → New → Progress note. Expect the "signed, active treatment plan is required" page (HTTP 409), and an audit row with action `blocked`, detail `progress note: no active treatment plan`.
2. Repeat with a Group note. Expect the same.
3. Create an intake note for the same patient. It must be allowed.
4. Create and sign a treatment plan so it becomes **active**. A progress note can now be created and signed.
5. (Optional, non-production) Complete or supersede the plan while a progress-note draft exists, then try to sign the draft. It must be refused with the plan-required message.

## 8. Website intake endpoint

| Control | Location |
|---|---|
| `POST /api/appointment-requests`: field allow-lists and length limits, email/phone validation, honeypot, **rate limit of 5 per IP per 10 minutes**, `no-store` | `ehr/src/routes/requests.js` |
| Staff inbox requires login + `requests:manage` (admin, frontdesk) | `ehr/src/routes/requests.js`, `ehr/src/permissions.js` |

**Verify:** Submit 6 test requests from one IP within 10 minutes. The 6th must get HTTP 429. Confirm a billing user can't open `/ehr/requests`.

## 9. Configuration reference (production)

| Variable | Required value | Secret? | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | no | Secure cookies, HSTS |
| `TRUST_PROXY` | `1` on Render | no | Real client IPs in the audit log |
| `EHR_DB_PATH` | `/var/data/ehr.sqlite` | no | Must be on the persistent disk |
| `EHR_TZ` | `[clinic zone]` | no | |
| `EHR_IDLE_MINUTES` | 30 or less (policy) | no | |
| `EHR_REQUIRE_MFA` | `1` | no | This release |
| `EHR_DATA_KEY` | random, see README | **yes** | This release. Escrow it. |
| `EHR_BACKUP_KEY` | random, see README | **yes** | This release. Escrow it. Must differ from `EHR_DATA_KEY`. |
| `EHR_ADMIN_EMAIL` / `EHR_ADMIN_PASSWORD` | first boot only | **yes** | **Delete** the password after first sign-in |
| `EHR_ADMIN_RESET` | unset | | Emergency recovery only; remove right after use |
| `EHR_DEMO` | **unset** | | Never set on production |

Render warns that environment-variable **names** must not contain PHI. None of these do.

## 10. Known technical gaps (tracked in the risk register)

- No application-level encryption of the SQLite file. The practice relies on the host's disk encryption (R18).
- Every clinician can open every patient's chart; there are no care-team restrictions. Audit review compensates (R6).
- EHR pages load fonts from Google (R16).
- `autoDeploy: true` deploys every push to the branch without review (R3).
- Single instance and single region; no automatic failover (R12).
- No independent penetration test yet (R8).
