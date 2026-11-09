# Policy: Minimum Necessary and Role-Based Access Matrix

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. The role matrix below reflects `ehr/src/permissions.js` and the route checks in `ehr/src/routes/*.js` as of this release. Re-check it whenever roles or permissions change. Complete the `[placeholders]` and adopt it.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.502(b), 164.514(d) (minimum necessary); 164.308(a)(3)–(4) (workforce access) |

## 1. The standard
Use, disclose, and request only the **minimum PHI reasonably necessary** for the purpose (164.502(b)). It does **not** apply to:
- disclosures to, or requests by, a provider **for treatment**;
- disclosures to the patient;
- uses or disclosures under a valid authorization;
- disclosures to HHS;
- disclosures required by law.

## 2. EHR roles and permissions (from `ehr/src/permissions.js`)

| Permission key | What it unlocks in the EHR | admin | clinician | frontdesk | billing |
|---|---|:-:|:-:|:-:|:-:|
| `patients:read` | Patient list and search; demographics, contacts, insurance; chart header | ✔ | ✔ | ✔ | ✔ |
| `patients:write` | Create and edit patients, insurance; allergies (also allowed with `clinical:write`) | ✔ | ✔ | ✔ | — |
| `clinical:read` | Clinical notes (except other clinicians' psychotherapy notes), treatment plans, diagnoses, medications, measures (PHQ-9/GAD-7), safety flags; right-of-access record export (this release) | ✔ | ✔ | — | — |
| `clinical:write` | Write and sign notes, addenda; treatment plans; diagnoses; medications; assessments | ✔ | ✔ | — | — |
| `schedule:read` | Calendars and appointments | ✔ | ✔ | ✔ | ✔ |
| `schedule:write` | Book, reschedule, check in, cancel, no-show | ✔ | ✔ | ✔ | — |
| `billing:read` | Charges, payments, ledger, superbills | ✔ | ✔ | ✔ | ✔ |
| `billing:write` | Create charges, post payments and adjustments, claim status | ✔ | — | — | ✔ |
| `requests:manage` | Website appointment-request inbox; convert a request to a patient | ✔ | — | ✔ | — |
| `admin` | Users and roles, audit log and CSV, patient access reports, fee schedule, /ehr/security alerts (this release), backups (this release) | ✔ | — | — | — |

Special rules enforced in code:
- **Psychotherapy notes** can be seen **only by their author**. Admins and other clinicians are excluded too (`canView()` in `ehr/src/routes/notes.js`).
- **Draft notes** can be edited or deleted only by their author. Signed notes are immutable.
- **Inactive users** have no permissions (`can()` requires `active = 1`).

## 3. Job titles → EHR role

| Job title at the practice | EHR role | Justification / limits |
|---|---|---|
| `[Owner / Clinical Director]` | admin | Practice management, user administration, audit review |
| `[Licensed therapist / counselor]` | clinician | Treatment |
| `[Psychiatrist / PMHNP]` | clinician | Treatment |
| `[Clinical intern / trainee]` | clinician | Treatment under supervision; supervisor reviews notes |
| `[Front desk / intake coordinator]` | frontdesk | Scheduling, registration, website requests. **No clinical content.** |
| `[Biller / billing service staff]` | billing | Claims and payments. Sees diagnosis codes on charges and superbills, as payment requires. **No notes.** |
| `[IT contractor]` | **No EHR account** by default. Hosting access only if needed, under a BAA | |

## 4. Known over-access and how it is compensated
These are design limits of the current EHR. They are listed in the risk register so the practice can decide whether to accept them.

| Issue | Why it exceeds minimum necessary | Compensating control |
|---|---|---|
| Every clinician can open **every** patient's chart. There is no care-team restriction. | A clinician only needs their own caseload, plus coverage | Workforce agreement; monthly targeted audit review (VIP, staff-as-patient, random sample); sanctions for snooping |
| `frontdesk` and `clinician` both have `billing:read` | Front desk may only need balances for collection at check-in | Accept, or ask the developer to narrow it `[decide]` |
| `admin` has full clinical access (except psychotherapy notes) | The admin may be a non-clinical manager | Give admin only to clinical owners, or have admins use a lower role for daily work |
| `billing` sees the schedule | Needed to match visits to charges | Accept |

## 5. Routine disclosures and requests (standard protocols, 164.514(d)(3))

| Routine disclosure | Minimum necessary content | Who |
|---|---|---|
| Claims to payers via CollaborateMD | Demographics, insurance, ICD-10, CPT, dates, provider NPI. **No notes**, unless the payer requests records for review; then send only what's requested. | Billing |
| Prior authorization / utilization review | What the payer's form requires; summary rather than full notes; **never psychotherapy notes** | Clinician |
| Appointment reminders | Name, date/time, clinic name. No diagnosis or service type, unless the patient agreed. | Front desk |
| Coordination of care with PCP (treatment) | Exempt from minimum necessary, but share what is useful. Part 2 records need consent. | Clinician |
| Records requests from attorneys, schools, employers | Only what the authorization specifies | Privacy Officer |

Non-routine disclosures are reviewed individually by the Privacy Officer.

## 6. Requests for access changes
Request a role change in writing to the Security Officer, with the reason. The Privacy Officer approves anything beyond the default mapping in §3.

## 7. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
