# Policy: Audit Logging and Information System Activity Review

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Adapt it, complete the `[placeholders]`, adopt it, and have counsel review it. Only promise a review schedule the practice will actually keep.

| | |
|---|---|
| Policy owner | Security Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.308(a)(1)(ii)(D), 164.308(a)(5)(ii)(C), 164.312(b), 164.312(c)(1) |
| Related | [../technical-controls.md](../technical-controls.md) §3, [incident-response-and-breach-notification.md](incident-response-and-breach-notification.md) |

## 1. Purpose
Record who accesses ePHI and what they do with it, review that activity on a regular schedule, and respond to anything suspicious.

## 2. What the EHR records
The EHR writes an `audit_log` entry for viewing and changing patient information, including:
- charts, notes, plans, billing, and superbills;
- signing, failed signing, addenda, and deletions;
- logins, logouts, failed logins, and lockouts;
- forbidden access attempts and blocked actions;
- exports (audit CSV, record exports);
- user administration (create, role change, deactivate, password reset) and admin recovery.

Each entry has a UTC timestamp, the user, the action, the entity, the patient, and the IP address. Entries describe *what happened*, never the clinical content.

**Implemented in this release (verify after deployment):**
- Entries are hash-chained (`prev_hash` → `hash`), so altering or deleting a past entry is detectable.
- Automated alerts appear on **/ehr/security**. Alert kinds include repeated failed logins, unusually high-volume access (`bulk_access`), after-hours access, a broken audit chain, and backup failure.

## 3. Policy

### 3.1 Protection of logs
- Only the **admin** role can view or export the audit log.
- Nobody may edit or delete audit entries. Audit records are kept for **at least 6 years** (see [retention.md](retention.md)).
- Exported audit CSVs contain PHI (patient IDs, names in the access report). Store them only on encrypted, practice-controlled storage, and delete them when the review is done.
- Each quarter, the Security Officer saves an audit CSV to `[write-once / separate BAA-covered storage]` as an independent copy.

### 3.2 Review schedule

| Frequency | Activity | Who | Where |
|---|---|---|---|
| **Each business day** (`[or 3×/week]`) | Check **/ehr/security** for open alerts. Acknowledge each one, investigate it, and resolve it with a note. | Security Officer (backup: `[name]`) | /ehr/security |
| **Weekly** | Scan the audit log for failed logins, `login_locked`, `forbidden`, and `export` entries | Security Officer | Admin → Audit log |
| **Monthly** | Targeted review: (a) charts of **workforce members who are also patients**, and of their relatives; (b) charts of **well-known or sensitive patients** `[list kept by the Privacy Officer]`; (c) a random sample of `[5]` patients' access reports, checking that each access had a treatment, payment, or operations reason; (d) access by recently terminated users (expect none) | Privacy Officer | Access report per patient |
| **Monthly** | Confirm the audit chain verifies and the latest backup is verified | Security Officer | /ehr/security, backups page |
| **Quarterly** | Access review (see the access-control policy); audit CSV archive | Security Officer | |
| **Annually** | Review this policy, the alert thresholds, and the review findings as part of the risk assessment | Both officers | |
| **On request** | Patient access report or accounting of disclosures (see patient-rights.md) | Privacy Officer | |

### 3.3 What counts as suspicious
Investigate any of the following:
- A user viewing a patient they have no appointment, note, billing, or request relationship with.
- High-volume chart viewing.
- Access outside the user's normal hours.
- Access after the user gave notice.
- Repeated `forbidden` entries (someone trying psychotherapy notes or admin pages).
- Logins from unexpected IP addresses or locations.
- Any `audit_chain_broken` or `backup_failed` alert.
- Any `admin_reset` that wasn't part of a planned recovery.

### 3.4 Response
1. Record the finding in the review log below.
2. If it could be inappropriate access, treat it as a **security incident** and follow [incident-response-and-breach-notification.md](incident-response-and-breach-notification.md). Don't confront the user before preserving evidence (export the relevant audit rows).
3. Apply sanctions per the workforce policy.

### 3.5 Application logs
Render service logs must contain **no PHI**, as both Render's HIPAA terms and this policy require. If PHI is ever found in logs, report it to the Security Officer as an incident and ask the developer to fix it.

## 4. Review log

| Date | Type (daily/weekly/monthly/…) | Reviewer | Findings | Follow-up / incident # |
|---|---|---|---|---|
| | | | | |

## 5. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
