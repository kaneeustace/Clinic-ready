# Policy: Record Retention and Destruction

> **TEMPLATE: REVIEW REQUIRED, STATE LAW CONTROLS MEDICAL RECORD RETENTION.** This is not legal advice. **HIPAA does not set a retention period for medical records.** It sets a 6-year period for HIPAA *documentation* (policies, BAAs, risk assessments, and so on). Medical record retention is set by `[State]` law, licensing boards, Medicare/Medicaid and payer contracts, and malpractice-carrier guidance. Counsel must fill in every `[period]` below. Adopt the policy once complete.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.316(b)(2)(i) and 164.530(j)(2) (6-year documentation retention); 164.310(d)(2)(i) (disposal); Medicare/Medicaid documentation requirements and payer contracts `[counsel to cite]`; state law: `[cite]` |

## 1. Retention schedule

| Record | Where it lives | Retention | Basis |
|---|---|---|---|
| Adult clinical record: notes, plans, assessments, diagnoses, medications, addenda | EHR | `[e.g. 7 years after last date of service]` | `[State statute / board rule]` |
| Minor's clinical record | EHR | `[e.g. until age of majority + N years, or N years after last service, whichever is later]` | `[State]` |
| Psychotherapy notes | EHR (private type) | `[same as clinical record, or per clinician/board guidance]` | `[State / board]` |
| SUD (Part 2) records | EHR | `[same as clinical record]`. Part 2 also has rules for records of discontinued programs (42 CFR 2.19). | `[State / Part 2]` |
| Billing records, charges, payments, superbills | EHR, CollaborateMD | `[e.g. 7–10 years]`. Payer contracts and False Claims Act exposure (up to 10 years) often drive this. | `[payer contracts / counsel]` |
| **Audit log** | EHR `audit_log` (+ quarterly CSV archive) | **At least 6 years**; `[recommended: same as the clinical record]` | 164.316 (documentation of security activity) |
| Security alerts and resolutions | EHR `security_alerts` | 6 years | 164.316 |
| Accounting of disclosures | EHR `disclosures` | **At least 6 years** (patients may request 6 years of history) | 164.528 |
| ROI / authorizations, Part 2 consents, revocations | EHR (ROI notes) | 6 years from when last in effect, or the clinical record period if longer | 164.508(b)(6), 164.530(j) |
| Website appointment requests **not** converted to patients | EHR `appointment_requests` | `[e.g. 1 year]`, then delete | Practice decision (minimum necessary). **The EHR has no automatic purge. Delete manually or ask the developer for a retention job.** |
| Policies, procedures, risk assessments, training records and attestations, sanctions, BAAs, incident and breach log, complaints, NPP versions | `[compliance folder]` | **6 years** from creation or the date last in effect, whichever is later | 164.316(b)(2), 164.530(j) |
| Encrypted backups | Backup storage | Rolling, per the contingency policy `[e.g. 12 months]` | Practice decision |
| Render daily snapshots | Render | Per Render | Vendor |
| Application logs | Render | Per Render. Must contain no PHI. | Vendor |
| Workforce access records (account creation and deactivation) | EHR audit log | 6 years | 164.316 |

## 2. Rules
1. **Don't destroy** records that are subject to a **litigation hold**, a subpoena, an investigation, an audit, or a pending patient request. The Privacy Officer keeps a hold list.
2. **The EHR doesn't delete patients or signed notes.** Only draft notes can be deleted, and only by their author. When the retention period ends, destroy the record per §3 after Privacy Officer approval, and document it.
3. Backups hold copies of everything. Once a record is destroyed from the live system, it will still exist in backups until they age out under the backup retention period. Note that in the destruction log.

## 3. Destruction methods
- **Electronic records in the EHR:** deletion by the developer or admin under a documented procedure `[to be developed; the EHR has no purge feature]`, recorded in the destruction log.
- **Devices and media:** per [device-and-media.md](device-and-media.md) (NIST SP 800-88).
- **Paper:** cross-cut shredding or a bonded vendor with a certificate of destruction.

## 4. Destruction log

| Date | Record type / MRN range | Retention basis met | Method | Approved by | Performed by | Certificate # |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. Practice closure or sale
Plan custodianship of the records in advance: notify patients, appoint a custodian, and arrange a hosting BAA for the custodian. Follow `[State]` rules. Counsel to advise.

## 6. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
