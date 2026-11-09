# HIPAA Compliance Package: Clinic Ready Behavioral Health

> **TEMPLATE: REVIEW REQUIRED BEFORE USE.** Everything in this folder is a starting template written for the Clinic Ready EHR as it exists in this repository. It is **not legal advice** and does not by itself make the practice HIPAA compliant. The practice's Privacy Officer and Security Officer must complete every `[placeholder]`, confirm every statement against how the practice actually operates, and adopt the documents formally. Qualified healthcare counsel licensed in `[State]` should review them, especially the parts on breach notification, patient rights, 42 CFR Part 2, minors, and retention, where state law often adds requirements.
>
> Draft version 0.1, prepared 2026-11-09. Next review: `[date]`.

## What this package is

HIPAA requires a covered entity to do three things that software can't do for it:

1. **Analyze its risks** (45 CFR 164.308(a)(1)(ii)(A)) and **manage them** (164.308(a)(1)(ii)(B)).
2. **Adopt written policies and procedures**, train the workforce on them, and keep them for 6 years (164.316, 164.530).
3. **Put agreements in place with vendors** that handle PHI (business associate agreements, or BAAs, under 164.308(b) and 164.502(e)).

This package pre-fills those documents for this EHR: its roles, its audit log, its hosting on Render, its website intake form, and so on. That way the practice reviews and corrects them instead of starting from a blank page.

### Controls implemented in this release (verify after deployment)

The following safeguards were added to the EHR in the same release as this package. They are described throughout as **"implemented in this release (verify after deployment)"**. Nobody should rely on one until the Security Officer has run the matching check in [technical-controls.md](technical-controls.md) against the production system.

| Control | Turned on by | Verify in |
|---|---|---|
| TOTP two-factor sign-in (optional per user; required for everyone with `EHR_REQUIRE_MFA=1`). TOTP secrets are encrypted with `EHR_DATA_KEY`. | Hosting environment variables | technical-controls.md §2 |
| Tamper-evident, append-only audit log (hash chain), with automated security alerts on the **/ehr/security** page | On by default | technical-controls.md §3 |
| Encrypted automated backups (AES-256-GCM with `EHR_BACKUP_KEY`), with verification, retention, and a command-line restore | `EHR_BACKUP_KEY` | technical-controls.md §4 |
| Patient right-of-access record export, plus an accounting of disclosures (`disclosures` table) | On by default | technical-controls.md §5 |

## Contents

| Document | Purpose | Owner |
|---|---|---|
| [risk-assessment.md](risk-assessment.md) | Security Risk Assessment pre-filled for this system: inventory, data flows, threats, controls mapped to the Security Rule, risk register | Security Officer |
| [technical-controls.md](technical-controls.md) | Each technical control, where it lives in code/config, and step-by-step production checks. Includes psychotherapy-note privacy and the treatment-plan gate: progress and group notes are blocked until the patient has an active, signed plan (`PLAN_REQUIRED_TYPES` in `src/routes/notes.js`). | Security Officer + IT/developer |
| [policies/access-control-and-authentication.md](policies/access-control-and-authentication.md) | Accounts, passwords, MFA, sessions, emergency access | Security Officer |
| [policies/audit-and-monitoring.md](policies/audit-and-monitoring.md) | What is logged, who reviews it and when, alert handling | Security Officer |
| [policies/contingency-backup-disaster-recovery.md](policies/contingency-backup-disaster-recovery.md) | Backups, restore testing, disaster recovery, emergency mode | Security Officer |
| [policies/device-and-media.md](policies/device-and-media.md) | Laptops, phones, tablets, printers, removable media, disposal | Security Officer |
| [policies/workforce-security-and-sanctions.md](policies/workforce-security-and-sanctions.md) | Hiring, onboarding, termination, sanctions | Privacy + Security Officers |
| [policies/incident-response-and-breach-notification.md](policies/incident-response-and-breach-notification.md) | Incident handling, 4-factor breach risk assessment, 60-day notification, breach log | Privacy Officer |
| [policies/minimum-necessary-and-role-matrix.md](policies/minimum-necessary-and-role-matrix.md) | Minimum necessary standard, with the EHR's actual roles and permissions | Privacy Officer |
| [policies/patient-rights.md](policies/patient-rights.md) | Access, amendment, accounting, restrictions, confidential communications, psychotherapy notes | Privacy Officer |
| [policies/part2-substance-use-records.md](policies/part2-substance-use-records.md) | 42 CFR Part 2 applicability and handling (2024 final rule) | Privacy Officer + counsel |
| [policies/vendor-and-baa-management.md](policies/vendor-and-baa-management.md) | Vendor inventory, BAA tracking, the Google Fonts note | Privacy Officer |
| [policies/retention.md](policies/retention.md) | Retention schedule and destruction | Privacy Officer + counsel |
| [training/workforce-training.md](training/workforce-training.md) | Onboarding and annual training outline, plus an attestation form | Privacy Officer |

## How to use this package

1. **Name your officers first** (checklist item 1). Every other document assigns work to them.
2. **Work through the owner action checklist below.** Items marked **Before PHI** must be done before real patient information goes into the EHR.
3. **Run the production checks** in [technical-controls.md](technical-controls.md) and record the results in the risk assessment.
4. **Complete the risk assessment.** Adjust the likelihood and impact ratings, set owners and due dates, then sign it.
5. **Edit each policy until it describes what you actually do.** A policy that says you review logs weekly when nobody does is worse than having no policy: in an investigation, it's evidence that you didn't follow your own rules. Delete anything that doesn't apply, and fill in every `[placeholder]`.
6. **Adopt the policies:** the owner signs and dates the adoption block in each one. Keep signed copies for 6 years after the later of creation or last effective date (164.316(b)(2)(i)).
7. **Train the workforce** and collect attestations.
8. **Review every year,** and after any significant change (new vendor, new host, new feature, an incident).

To search for unfinished items: `grep -rn "\[" docs/hipaa/` lists every placeholder.

---

## OWNER ACTION CHECKLIST

These are the things only people can do. Code can't sign a contract, appoint an officer, or decide what risk is acceptable. "Owner" means the practice owner or managing clinician unless the item says otherwise.

**Priority:** **Before PHI** = must be done before any real patient information is entered. **30 days** = within 30 days of go-live. **Ongoing** = recurring.

### 1. Designate a Privacy Officer and a Security Officer (Before PHI)
- **Why:** Both are required. See 164.530(a) (privacy official) and 164.308(a)(2) (assigned security responsibility). In a small practice one person can hold both roles.
- **How:** Write a one-paragraph designation memo with name, title, start date, and duties, and have the owner sign it. Put the Privacy Officer's contact details on `privacy.html` and in the Notice of Privacy Practices; the page currently has placeholders.
- **Who:** Owner.
- [ ] Privacy Officer: `[name]` Date: `[ ]`
- [ ] Security Officer: `[name]` Date: `[ ]`

### 2. Move hosting to a HIPAA-enabled environment and sign the hosting BAA (Before PHI)
- **Why:** Render stores the database, its disk snapshots, and the running app, so it is a business associate. Without a signed BAA, any PHI stored there is an impermissible disclosure. Render's standard workspaces are **not** covered.
- **How (Render):** Per [Render's HIPAA documentation](https://render.com/docs/hipaa-compliance), checked 2026-11-09 (confirm the current terms yourself):
  - A HIPAA-enabled workspace requires a **Scale or Enterprise** workspace plan.
  - A workspace admin turns it on under **Workspace Settings → Compliance → Get Started**. Render then emails the BAA for signature, and you click **Enable HIPAA**. Render redeploys services to access-restricted hosts, which may cause brief downtime.
  - Render adds a **20% surcharge** on all usage in the workspace.
  - The upgrade **cannot be reversed**.
  - **Free instances are not allowed.** This repo's `render.yaml` also defines a free `clinic-ready-demo` service. Keep that demo in a **separate, non-HIPAA workspace**, or delete it from the blueprint. Never put real data in the demo.
  - Render says **service logs, build artifacts, `render.yaml`, and resource or environment-variable names must never contain PHI.**
  - Persistent disks and their daily snapshots are covered and encrypted at rest.
- **Alternative hosts:** If you don't use Render, use the root `Dockerfile` on a HIPAA-eligible service under a signed BAA (for example AWS, Azure, Google Cloud, or Aptible). Mount an encrypted volume at `/var/data`.
- **Who:** Owner signs. Security Officer records it in the vendor inventory.

### 3. Confirm the persistent disk is attached (Before PHI)
- **Why:** The database is a single SQLite file (`EHR_DB_PATH=/var/data/ehr.sqlite`). Without a persistent disk, every restart or redeploy **erases all records**.
- **How:** In Render, confirm the service has disk `ehr-data` mounted at `/var/data` (defined in `render.yaml`). Size it for growth, starting at 1 GB. Restart the service once and confirm a test record survives. See technical-controls.md §4.
- **Who:** Security Officer or IT.

### 4. Generate and set encryption keys, and keep them safe (Before PHI)
- **Why:**
  - `EHR_DATA_KEY` encrypts each user's two-factor secret.
  - `EHR_BACKUP_KEY` encrypts backups (AES-256-GCM).
  - **If you lose `EHR_BACKUP_KEY`, your backups can't be restored. If it leaks, anyone holding a backup file can read all your PHI.**
- **How:**
  1. Generate each key with a cryptographically secure generator. For example, run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` once per key. Confirm the exact format the code expects in the deployed README.
  2. Set the keys as **secret** environment variables in the hosting dashboard. Never commit them to git or put them in `render.yaml`.
  3. Store each key in the practice's password manager, which must be covered by a BAA or must not contain PHI.
  4. Keep a sealed **escrow copy** (printed and kept in a locked safe, or with counsel) so the practice can recover if the Security Officer is unavailable.
  5. Use **different** values for the two keys.
  6. Record the date each key was created; rotation is described in technical-controls.md.
- **Who:** Security Officer generates and stores. Owner holds the escrow copy.

### 5. Require two-factor sign-in for everyone (Before PHI)
- **Why:** Stolen passwords are the most common way into small-practice systems. MFA is strongly recommended by HHS, NIST SP 800-66r2, and HHS's 405(d) "HICP" practices. It was also a required control in HHS's January 2025 Security Rule proposed rule, which was not final when this was written; see the risk assessment.
- **How:**
  1. Each user enrolls an authenticator app (TOTP).
  2. After everyone has enrolled, set `EHR_REQUIRE_MFA=1` in the hosting environment and redeploy.
  3. Store recovery codes securely.
  4. Verify using technical-controls.md §2.
- **Who:** Security Officer. Every workforce member enrolls.

### 6. Sign BAAs with every other vendor that touches PHI (Before PHI)
- **Why:** Required by 164.308(b) and 164.502(e).
- **How:** Use the inventory in [vendor-and-baa-management.md](policies/vendor-and-baa-management.md). At minimum:
  - **CollaborateMD** (billing and claims; request their BAA through your account representative)
  - **Email** (for example Google Workspace or Microsoft 365, with the BAA accepted in the admin console)
  - **Fax service**
  - **Telehealth platform**
  - **Phone/SMS or appointment-reminder** vendor
  - **Off-site backup storage**
  - Any **IT contractor** with administrator access

  Don't use consumer accounts (personal Gmail, personal Dropbox, and so on) for PHI.
- **Who:** Owner signs. Privacy Officer tracks renewal dates.

### 7. Keep encrypted backup copies off-site and test a restore (30 days, then quarterly)
- **Why:** A contingency plan with a data backup plan and a disaster recovery plan is required (164.308(a)(7)). Render's disk snapshots live with the same provider, so a separate copy protects against account loss, ransomware, or deletion.
- **How:** Copy the encrypted backup files from the EHR's backup job to a second location covered by a BAA. Examples: an S3 bucket with Object Lock in a separate cloud account, or an encrypted drive kept in a safe. Every quarter, restore a backup into a **non-production** environment with the command-line restore and confirm records are present. Log the result. See [contingency-backup-disaster-recovery.md](policies/contingency-backup-disaster-recovery.md).
- **Who:** Security Officer.

### 8. Complete and sign the Security Risk Assessment (Before PHI, then annually)
- **Why:** The risk analysis is the requirement HHS OCR cites most often in enforcement actions.
- **How:**
  1. Review [risk-assessment.md](risk-assessment.md) and correct anything that doesn't match how you operate.
  2. Run the production checks and record the results.
  3. Set an owner and due date for each open risk.
  4. Sign it.
  5. Optionally, cross-check it with the free [HHS/ONC SRA Tool](https://www.healthit.gov/topic/privacy-security-and-hipaa/security-risk-assessment-tool).
- **Who:** Security Officer completes it. Owner signs and accepts the residual risk.

### 9. Adopt the policies (Before PHI)
- **How:** Edit each policy in `policies/` until it is true for your practice, then sign and date its adoption block. Keep them for 6 years.
- **Who:** Owner, plus the officer named in each policy.

### 10. Train the workforce (Before PHI access, then annually)
- **Why:** Training is required by 164.308(a)(5) and 164.530(b). Training must happen before a person gets access, and the practice must document it.
- **How:** Use [training/workforce-training.md](training/workforce-training.md). Collect a signed attestation from each person before activating their EHR account.
- **Who:** Privacy Officer delivers it. Every workforce member, including the owner and contractors, completes it.

### 11. Have counsel review patient-facing documents (Before PHI)
Counsel should review:
- **Notice of Privacy Practices** (`privacy.html` summary and the full NPP). The NPP must reflect the 2024 Part 2 rule changes if Part 2 applies; the compliance date was 2026-02-16. It must also cover state-law protections.
- **Release of Information (ROI) / authorization form.** The EHR's ROI note type records consent details but is not itself a compliant authorization form. The form must meet 164.508(c).
- **Part 2 consent form**, if the practice is a Part 2 program or receives Part 2 records. Use the 42 CFR 2.31 elements, including the single TPO consent option.
- **Minors' consent and access rules** for `[State]`.
- **Telehealth consent.**
- **Website privacy policy**, including the form-handling placeholder.

**Who:** Privacy Officer coordinates. Counsel reviews.

### 12. Set up the incident and breach log (Before PHI)
- **How:** Create the log from the template in [incident-response-and-breach-notification.md](policies/incident-response-and-breach-notification.md) as a restricted spreadsheet or document. Put the incident reporting contact on the staff contact sheet. Calendar the annual HHS submission for breaches affecting fewer than 500 people, which is due within 60 days after the end of each calendar year.
- **Who:** Privacy Officer.

### 13. Set production configuration and remove bootstrap secrets (Before PHI)
- **How:**
  - Confirm `NODE_ENV=production` and `TRUST_PROXY=1`.
  - After the first admin signs in, **delete `EHR_ADMIN_PASSWORD`** from the environment, as the README instructs.
  - Make sure `EHR_DEMO` is **not** set on the production service.
  - Set `EHR_TZ` to the clinic's time zone.
  - Consider turning off `autoDeploy` and requiring review before any deploy (see the risk register).
- **Who:** Security Officer.

### 14. Self-host web fonts on EHR pages (30 days; recommended)
- **Why:** EHR pages load the Inter font from Google Fonts, which tells Google the user's IP address and the time of each visit. This is low risk and probably not PHI, but no BAA covers it. See [vendor-and-baa-management.md](policies/vendor-and-baa-management.md#google-fonts).
- **How:** Ask the developer to serve the font files from `/ehr/static` and remove `fonts.googleapis.com` and `fonts.gstatic.com` from the CSP. Consider doing the same on the public site's form pages (`contact.html`).
- **Who:** Security Officer asks; developer implements.

### 15. Get an independent security review / penetration test (Within 90 days of go-live)
- **Who:** Owner engages a qualified firm. Security Officer tracks the findings in the risk register.

### 16. Annual review (Ongoing, every `[month]`)
- [ ] Update and re-sign the risk assessment
- [ ] Review and re-adopt policies
- [ ] Repeat annual training and collect attestations
- [ ] Review the user list against current staff
- [ ] Run a restore test
- [ ] Renew and review BAAs
- [ ] Submit the HHS log of breaches affecting fewer than 500 people (by 60 days after year end)
- [ ] Review regulatory changes (Security Rule final rule status, Part 2, state law)

**Who:** Privacy + Security Officers. Owner signs off.

---

## Key sources

- HHS, *Summary of the HIPAA Security Rule*: https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html
- HHS, *Guidance on Risk Analysis*: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- HHS/ONC, *Security Risk Assessment (SRA) Tool*: https://www.healthit.gov/topic/privacy-security-and-hipaa/security-risk-assessment-tool
- NIST SP 800-66 Rev. 2, *Implementing the HIPAA Security Rule: A Cybersecurity Resource Guide* (Feb 2024): https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS, *Breach Notification Rule*: https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html
- HHS 405(d), *Health Industry Cybersecurity Practices (HICP)*: https://405d.hhs.gov/
- Federal Register, *Confidentiality of Substance Use Disorder (SUD) Patient Records* final rule, 89 FR 12472 (Feb 16, 2024): https://www.federalregister.gov/documents/2024/02/16/2024-02544/confidentiality-of-substance-use-disorder-sud-patient-records
- Render, *HIPAA compliance on Render*: https://render.com/docs/hipaa-compliance
- eCFR, 45 CFR Part 164: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164
- eCFR, 42 CFR Part 2: https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2

> **Regulatory status note (uncertain; verify):** HHS published a proposed rule to overhaul the Security Rule in January 2025 (90 FR 898). The proposal would make MFA, encryption, asset inventories, and annual compliance audits explicit requirements. As of the latest reporting found while drafting (mid-2026), it was **not final**, and HHS's regulatory agenda listed final action for July 2027. Check https://www.reginfo.gov and https://www.federalregister.gov for current status. This package already treats those proposed controls as good practice.
