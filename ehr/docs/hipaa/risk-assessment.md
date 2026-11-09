# Security Risk Assessment: Clinic Ready EHR

> **TEMPLATE: REVIEW REQUIRED.** This assessment is pre-filled from the EHR's source code and deployment files. It is not legal advice. Before it counts as the practice's risk analysis under 45 CFR 164.308(a)(1)(ii)(A), the Security Officer must:
> - confirm each statement against the **production** system and the practice's real operations, using the checks in [technical-controls.md](technical-controls.md);
> - adjust the ratings;
> - assign owners and dates;
> - sign it.
>
> Anything marked **[verify]** has not been confirmed in production. Have counsel or a qualified assessor review it.

| | |
|---|---|
| Organization | Clinic Ready Behavioral Health, `[legal name, address]` |
| Assessment period | `[start]` to `[end]` |
| Performed by | `[Security Officer name]`, with `[others]` |
| Method | NIST SP 800-30-style qualitative analysis, as recommended in HHS *Guidance on Risk Analysis* and NIST SP 800-66r2 §3. Cross-checked against the HHS/ONC SRA Tool: `[yes/no, date]` |
| System version | Git commit `[hash]` deployed `[date]` |
| Next full review | `[date]`. Due annually, and after any significant change. |

Sources:
- HHS Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66r2: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS/ONC SRA Tool: https://www.healthit.gov/topic/privacy-security-and-hipaa/security-risk-assessment-tool

---

## 1. Scope

This assessment covers all electronic PHI (ePHI) the practice creates, receives, maintains, or transmits through the systems below. The risk assessment for paper records, the office, and the phone system is in §1.4.

### 1.1 System inventory

| # | Asset | Description | ePHI? | Location / vendor | BAA |
|---|---|---|---|---|---|
| A1 | **Clinic Ready EHR application** | Node.js 22 + Express 5 app (`ehr/`). Serves the public website, the website intake API (`/api/appointment-requests`), and the EHR (`/ehr`). | Yes | Render web service `clinic-ready` (`render.yaml`), or a Docker host | Render: `[status]` |
| A2 | **EHR database** | A single SQLite file at `EHR_DB_PATH` (`/var/data/ehr.sqlite`) in WAL mode. Holds every patient, note, plan, billing record, appointment request, user, session, and audit row. | Yes, all of it | Render persistent disk `ehr-data` | Render |
| A3 | **Render disk snapshots** | Render's automatic daily disk snapshots | Yes | Render | Render |
| A4 | **Encrypted application backups** *(implemented in this release; verify after deployment)* | AES-256-GCM encrypted backup files (`EHR_BACKUP_KEY`), with verification and retention | Yes (encrypted) | `[on-disk path]` + off-site copy at `[location]` | `[off-site vendor BAA]` |
| A5 | **Hosting control plane** | Render dashboard: environment variables (keys), deploys, shell access, logs | Indirectly: access to A1–A3 and the keys | Render | Render |
| A6 | **Source repository** | GitHub repo; `autoDeploy: true` means every push to the deploy branch goes to production | No PHI (must stay that way) | GitHub | Not needed if it holds no PHI |
| A7 | **Application logs** | stdout/stderr. `console.error(err)` on server errors (`app.js`). | Should be none. **Risk:** error messages or stack traces could contain PHI. | Render logs | Render. Render says logs must never contain PHI. |
| A8 | **Public website** | Static HTML pages, served by A1 | No, except the contact form | Render | — |
| A9 | **CollaborateMD** | Billing / clearinghouse | Yes (demographics, insurance, diagnoses, CPT, dates of service) | CollaborateMD (cloud) | `[status]` |
| A10 | **Email** | `[Google Workspace / Microsoft 365 / other]`, `[domain]` | Likely: patient correspondence, internal | `[vendor]` | `[status]` |
| A11 | **Fax** | `[eFax vendor / physical fax]` for records requests and ROI | Yes | `[vendor]` | `[status]` |
| A12 | **Telehealth platform** | `[platform name]`. Its link is stored on appointments. | Yes (video, sometimes chat) | `[vendor]` | `[status]` |
| A13 | **Phone / SMS / reminders** | `[vendor]` | Yes (names, appointment times) | `[vendor]` | `[status]` |
| A14 | **Workstations and mobile devices** | Laptops, desktops, phones, and tablets that open the EHR in a browser, plus printers used for superbills and records | Transient (browser memory, printouts, downloads such as audit CSVs and record exports) | Office / home | — |
| A15 | **Password manager** | Stores admin credentials and `EHR_DATA_KEY` / `EHR_BACKUP_KEY` | Keys to ePHI | `[vendor]` | `[status, or confirm it holds no PHI]` |
| A16 | **Google Fonts** | EHR pages load Inter from `fonts.googleapis.com` / `fonts.gstatic.com`. The public site also loads Fraunces. | No PHI in the request. Reveals viewer IP and time. | Google | None. See vendor policy. |
| A17 | **Demo service** `clinic-ready-demo` | Free instance with synthetic data that resets on restart | Must never hold PHI | Render | Must sit outside the HIPAA workspace |

### 1.2 Data flows

```
 Prospective patient                        Workforce browser (office / home / phone)
        |                                              |
        | HTTPS POST /api/appointment-requests         | HTTPS /ehr  (session cookie, CSRF, MFA)
        v                                              v
 +--------------------------------------------------------------+
 |  Render web service "clinic-ready" (A1)                       |
 |   - security headers, CSP, HSTS, no-store                     |
 |   - SQLite DB on persistent disk /var/data (A2) ---> Render    |
 |     daily snapshots (A3)                                      |
 |   - encrypted backups (A4) ---> off-site copy [location]      |
 |   - logs (A7) ---> Render log stream (no PHI allowed)         |
 +--------------------------------------------------------------+
        |                          |                       |
        | superbill print/PDF,     | right-of-access       | audit CSV export
        | manual entry [verify]    | export, ROI release   | (admin only)
        v                          v                       v
   CollaborateMD (A9)         Patient / recipient      Admin workstation (A14)
   -> payers (837/835)        via [portal/mail/fax/
                               secure email] (A10/A11)
```

| Flow | Data | Transport | Protection now | Gaps |
|---|---|---|---|---|
| F1. Website form → EHR | Name, preferred name, DOB, phone, email, contact preference, voicemail OK, who care is for, service wanted, insurance, reason for visit (up to 1,000 characters), referral source, IP | HTTPS to the same host. Stored in `appointment_requests`. | TLS (Render), honeypot, rate limit, `no-store`, input length limits. The privacy page asks people not to send detailed health information. | The form sits on a page that loads Google Fonts. No retention or purge rule for unconverted requests. |
| F2. Workforce → EHR | All PHI | HTTPS | Secure, HttpOnly, SameSite=Strict cookies; CSRF tokens; same-origin check; idle timeout (30 min) and absolute timeout (12 h); RBAC; MFA (this release) | Device security depends on policy (A14) |
| F3. EHR → CollaborateMD | Demographics, insurance, ICD-10, CPT, dates of service, charges | `[method: superbill printed or saved as PDF and keyed in / CSV upload / other]` **[verify]**. The code has no direct integration. | Billing role only; superbill view is audited | Saved PDFs or printouts on workstations; needs a BAA |
| F4. EHR → backups | Full database | `[backup job → disk → off-site]` | AES-256-GCM (this release) | Key management; off-site copy not yet set up **[verify]** |
| F5. EHR → patient / third parties | Record exports, ROI releases | `[portal / mail / fax / secure email]` | Disclosures logged in `disclosures` (this release); ROI note type captures consent details | Manual steps; Part 2 redisclosure notice |
| F6. Email / phone / SMS | Scheduling, some clinical content | Vendor | `[vendor controls]` | Patient preference for unencrypted email must be documented (see patient-rights.md) |
| F7. Hosting control plane | Keys, shell, logs | HTTPS to Render | `[Render account MFA? verify]` | Render account compromise would expose everything; enforce MFA on Render and GitHub |

### 1.3 Workforce and roles

`[number]` workforce members. EHR roles come from `ehr/src/permissions.js`: **admin, clinician, frontdesk, billing**. The full matrix is in [minimum-necessary-and-role-matrix.md](policies/minimum-necessary-and-role-matrix.md).

### 1.4 Out-of-system items to assess separately

- Paper records and printouts: `[describe]`
- Office physical security: locks, visitor control, alarm: `[describe]`
- Network: office Wi-Fi, guest network separation: `[describe]`
- Remote and home work: `[describe]`

---

## 2. Threats and vulnerabilities

| ID | Threat source / event | Vulnerability | Affected assets |
|---|---|---|---|
| T1 | Credential theft (phishing, password reuse) | Passwords alone allow sign-in until MFA is enforced | A1, A2 |
| T2 | Hosting or GitHub account takeover | Control-plane accounts not confirmed to use MFA; `autoDeploy` ships any push straight to production | A1–A6 |
| T3 | Malicious or curious insider viewing records (snooping, including the records of staff or well-known patients) | Every clinician can read every patient's chart. There is no care-team restriction. | A2 |
| T4 | Data loss (disk failure, accidental deletion, bad migration, ransomware) | A single SQLite file on one disk; snapshots kept with the same provider | A2, A3 |
| T5 | Loss of `EHR_BACKUP_KEY` / `EHR_DATA_KEY` | Single custodian, no escrow | A4 |
| T6 | Stolen or lost laptop or phone | Downloaded exports, cached sessions, unencrypted devices | A14 |
| T7 | Web application attack (injection, XSS, CSRF, session hijack) | Custom code that hasn't had an independent pen test | A1 |
| T8 | PHI in logs | `console.error(err)` may log error details | A7 |
| T9 | Disclosure to a vendor without a BAA | CollaborateMD, email, fax, telehealth, or SMS used before BAAs are signed; the Google Fonts request | A9–A13, A16 |
| T10 | Website form abuse or spam; PHI submitted through the form | Public endpoint | A1, A2 |
| T11 | Audit log tampering by someone with database or shell access | The audit log lives in the same database | A2 |
| T12 | Service outage (Render incident, expired card, account suspension) | Single region and single instance; no failover | A1 |
| T13 | Misdirected disclosure (wrong fax number or email, over-disclosure, Part 2 redisclosure) | Manual release process | F5 |
| T14 | Demo or production confusion | The demo service and production share a blueprint | A17 |
| T15 | Departed workforce member keeps access | Manual deprovisioning | A1, A9–A13 |
| T16 | Psychotherapy notes exposed | Admins and other clinicians could see them if access control fails | A2 |
| T17 | Vulnerable dependency (Express, Node) | Supply chain | A1 |
| T18 | Natural disaster or office loss | Paper records, devices | Office |

---

## 3. Existing controls mapped to the Security Rule

Status key:
- **Code:** implemented in the current code before this release.
- **Release:** implemented in this release (verify after deployment).
- **Org:** an organizational or human action, tracked in the README checklist.
- **Gap:** not yet addressed.

R = required implementation specification. A = addressable.

### 3.1 Administrative safeguards: 164.308

| Standard / spec | How this practice meets it | Status |
|---|---|---|
| (a)(1)(ii)(A) Risk analysis (R) | This document | Org: complete and sign |
| (a)(1)(ii)(B) Risk management (R) | Risk register in §5 | Org |
| (a)(1)(ii)(C) Sanction policy (R) | [workforce-security-and-sanctions.md](policies/workforce-security-and-sanctions.md) | Org: adopt |
| (a)(1)(ii)(D) Information system activity review (R) | Audit log viewer and CSV export (`/ehr/admin/audit`), per-patient access report, security alerts on `/ehr/security`; review schedule in [audit-and-monitoring.md](policies/audit-and-monitoring.md) | Code + Release + Org |
| (a)(2) Assigned security responsibility (R) | Security Officer designation | Org |
| (a)(3) Workforce security: authorization/supervision, clearance, termination (A) | Admin → Users: create, assign role, deactivate (revokes sessions) and reset password (revokes sessions); onboarding and offboarding checklist | Code + Org |
| (a)(4) Information access management: access authorization and establishment/modification (A) | Four roles in `permissions.js`; `requirePerm()` middleware; role changes audited | Code + Org |
| (a)(5) Security awareness and training: reminders, malware protection, log-in monitoring, password management (A) | Training program; failed-login audit entries and lockout; failed-login alerts | Code + Release + Org |
| (a)(6) Security incident procedures (R) | [incident-response-and-breach-notification.md](policies/incident-response-and-breach-notification.md) | Org |
| (a)(7) Contingency plan: data backup, DR, emergency mode (R); testing, criticality analysis (A) | Encrypted backups, verification, retention, CLI restore; Render snapshots; [contingency plan](policies/contingency-backup-disaster-recovery.md) | Release + Org |
| (a)(8) Evaluation (R) | Annual review; production checks in technical-controls.md; independent pen test | Org |
| (b)(1) Business associate contracts (R) | [vendor-and-baa-management.md](policies/vendor-and-baa-management.md) | Org: **sign BAAs** |

### 3.2 Physical safeguards: 164.310

| Standard / spec | How met | Status |
|---|---|---|
| (a)(1) Facility access controls (A specs) | Data center: inherited from Render under the BAA (Render's SOC 2 report: `[request and file]`). Office: `[locks, alarm, visitor log]`. | Org |
| (b) Workstation use (R) | [device-and-media.md](policies/device-and-media.md) | Org |
| (c) Workstation security (R) | Screen lock, privacy screens, device encryption | Org |
| (d)(1) Device and media controls: disposal (R), media re-use (R), accountability (A), data backup and storage (A) | Device inventory; secure wipe; backup media handling | Org |

### 3.3 Technical safeguards: 164.312

| Standard / spec | How met | Where | Status |
|---|---|---|---|
| (a)(2)(i) Unique user identification (R) | One account per person, unique email (`users.email UNIQUE`); shared accounts prohibited by policy | `schema.sql`, `routes/admin.js` | Code + Org |
| (a)(2)(ii) Emergency access procedure (R) | `EHR_ADMIN_RESET=1` recovery (`bootstrap.js`), which is audited as `admin_reset`; documented in the contingency policy | `bootstrap.js` | Code + Org |
| (a)(2)(iii) Automatic logoff (A) | 30-minute idle timeout (`EHR_IDLE_MINUTES`) and 12-hour absolute session limit; expired sessions purged hourly | `auth.js`, `server.js` | Code |
| (a)(2)(iv) Encryption and decryption (A) | At rest: Render disk encryption under the HIPAA workspace **[verify]**; TOTP secrets encrypted with `EHR_DATA_KEY`; backups encrypted with AES-256-GCM. The SQLite file itself has no application-level encryption. | Render; this release | Release + Org |
| (b) Audit controls (R) | `audit_log` records views, changes, signing, logins, failed logins, forbidden attempts, and exports; hash chain (`prev_hash`, `hash`) makes tampering detectable; alerts | `audit.js`, `db.js`, `/ehr/security` | Code + Release |
| (c)(1) Integrity; (c)(2) mechanism to authenticate ePHI (A) | Signed notes are immutable, corrections go in append-only addenda, signing requires the password; signed treatment plans; audit hash chain; backup verification; SQLite constraints | `routes/notes.js`, `routes/plans.js` | Code + Release |
| (d) Person or entity authentication (R) | scrypt-hashed passwords (12+ characters, 3 of 4 character classes); lockout after 5 failures for 15 minutes; TOTP MFA | `auth.js` | Code + Release |
| (e)(1) Transmission security: integrity controls and encryption (A) | HTTPS (Render TLS); HSTS in production; secure cookies; `TRUST_PROXY` | `app.js`, `render.yaml` | Code + Org (verify HTTPS-only) |

Related Privacy Rule controls in the code:
- Psychotherapy notes are visible only to their author (`canView()` in `routes/notes.js`). Admins are excluded too.
- `Cache-Control: no-store` on EHR and API responses.
- The accounting of disclosures (`disclosures` table) and the per-patient access report.
- Progress and group notes are blocked until a signed, active treatment plan exists (`PLAN_REQUIRED_TYPES`). This is a documentation-integrity and payer control, not a HIPAA requirement.

---

## 4. Rating method

**Likelihood:** 1 = Low (unlikely in a year), 2 = Medium (possible), 3 = High (likely).
**Impact:** 1 = Low (little or no PHI, short disruption), 2 = Medium (limited PHI or a day of outage), 3 = High (large PHI exposure, data loss, or reportable breach).
**Risk = L × I.** 1–2 = Low, 3–4 = Medium, 6–9 = High.

The ratings below are the drafter's starting estimates. The practice must adjust them.

## 5. Risk register

| ID | Risk | L | I | Risk | Existing controls | Remediation | Owner | Due | Status |
|---|---|---|---|---|---|---|---|---|---|
| R1 | Hosting without a BAA, or PHI on non-HIPAA infrastructure (T9, T14) | 3 | 3 | **High** | `render.yaml` warning | Enable Render's HIPAA workspace (Scale/Enterprise) and sign the BAA; move the demo to a separate workspace | `[Owner]` | Before PHI | Open |
| R2 | Account takeover via stolen password (T1) | 3 | 3 | **High** | Password policy, lockout, audit | Set `EHR_REQUIRE_MFA=1` after everyone enrolls; verify | `[SO]` | Before PHI | Open |
| R3 | Hosting or GitHub control-plane takeover (T2) | 2 | 3 | **High** | — | Enforce MFA on Render and GitHub; limit Render workspace members; turn off `autoDeploy` or protect the deploy branch with required review | `[SO]` | Before PHI | Open |
| R4 | Permanent data loss (T4) | 2 | 3 | **High** | Persistent disk, Render snapshots, encrypted backups (Release) | Confirm the disk; off-site encrypted copy; quarterly restore test | `[SO]` | 30 days | Open |
| R5 | Backup key lost or leaked (T5) | 1 | 3 | Medium | — | Password manager + sealed escrow; separate keys | `[SO]` | Before PHI | Open |
| R6 | Insider snooping (T3) | 2 | 3 | **High** | Audit log, access report, alerts, sanctions | Monthly audit review; flag VIP and staff-as-patient charts in the review; consider care-team restrictions in a future release | `[PO]` | Ongoing | Open |
| R7 | Lost or stolen device with downloaded PHI (T6) | 2 | 2 | Medium | `no-store`, session timeout | Full-disk encryption, screen lock, MDM or remote wipe; no downloads to personal devices | `[SO]` | 30 days | Open |
| R8 | Web vulnerability (T7, T17) | 2 | 3 | **High** | CSP, CSRF, same-origin check, escaping templates, parameterized SQL, 97+ tests | Independent pen test; dependency updates (`npm audit` monthly) | `[Owner]` | 90 days | Open |
| R9 | PHI in application logs (T8) | 2 | 2 | Medium | The audit helper forbids PHI in `detail` | Review Render logs for PHI; have the developer make sure error logging leaves out request bodies | `[SO]` | 30 days | Open |
| R10 | Vendor without a BAA (T9) | 3 | 2 | **High** | — | Sign BAAs (CollaborateMD, email, fax, telehealth, SMS, backup storage) | `[PO]` | Before PHI | Open |
| R11 | Audit log tampering (T11) | 1 | 2 | Low | Hash chain + `audit_chain_broken` alert (Release) | Periodic CSV export to write-once storage | `[SO]` | Quarterly | Open |
| R12 | Extended outage (T12) | 2 | 2 | Medium | Health check, Render auto-restart | Emergency-mode paper procedures; billing alerts on the hosting account; keep the Render payment method current | `[SO]` | 30 days | Open |
| R13 | Misdirected or over-broad disclosure (T13) | 2 | 2 | Medium | ROI note type, disclosure log, Part 2 notice text | Verify fax and email recipients; minimum necessary; second-person check for Part 2 | `[PO]` | Ongoing | Open |
| R14 | Late deprovisioning (T15) | 2 | 2 | Medium | Deactivate revokes sessions | Same-day offboarding checklist; quarterly user review | `[SO]` | Ongoing | Open |
| R15 | Website form receives sensitive PHI (T10) | 2 | 1 | Low | Rate limit, honeypot, privacy notice | Retention rule for unconverted requests; self-host fonts on `contact.html` | `[PO]` | 60 days | Open |
| R16 | Third-party font requests (A16) | 3 | 1 | Low | CSP limits font origins | Self-host fonts and tighten the CSP | `[SO]` | 60 days | Open |
| R17 | Untrained workforce | 2 | 3 | **High** | — | Training before access; annual refresher | `[PO]` | Before PHI | Open |
| R18 | No encryption for the SQLite file beyond the disk layer | 1 | 3 | Medium | Render disk encryption **[verify]** | Accept, with documentation, or plan application-level encryption | `[Owner]` | `[ ]` | Open |
| R19 | Bootstrap admin password left in the environment | 2 | 2 | Medium | README instruction | Delete `EHR_ADMIN_PASSWORD` after first sign-in; never leave `EHR_ADMIN_RESET` set | `[SO]` | Before PHI | Open |
| R20 | `[add practice-specific risks]` | | | | | | | | |

## 6. Production verification results

Record the results of each check in [technical-controls.md](technical-controls.md):

| Check | Date | Result | By |
|---|---|---|---|
| §1 HTTPS, headers, cookies | | | |
| §2 MFA enforced | | | |
| §3 Audit log + hash chain + alerts | | | |
| §4 Backups + restore test | | | |
| §5 Right of access export + disclosures | | | |
| §6 Psychotherapy note privacy | | | |
| §7 Treatment-plan gate | | | |

## 7. Sign-off

I have reviewed this risk analysis. I accept the residual risks listed as Low, and I approve the remediation plan for the rest.

Security Officer: ____________________ Date: ________
Owner / Managing Clinician: ____________________ Date: ________
