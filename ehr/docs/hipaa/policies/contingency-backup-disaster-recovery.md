# Policy: Contingency Plan (Backup, Disaster Recovery, Emergency Mode)

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Adapt it, complete the `[placeholders]`, test it, and adopt it. Recovery targets must be realistic for the hosting plan you chose.

| | |
|---|---|
| Policy owner | Security Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.308(a)(7)(i)–(ii)(A)–(E); 164.310(a)(2)(i); 164.310(d)(2)(iv); 164.312(a)(2)(ii) |
| Related | [../technical-controls.md](../technical-controls.md) §4 |

## 1. Applications and data criticality analysis (164.308(a)(7)(ii)(E))

| System | Criticality | Recovery time objective (RTO) | Recovery point objective (RPO) | Manual workaround |
|---|---|---|---|---|
| EHR (charts, notes, schedule) | **High** | `[8 business hours]` | `[24 h]` (daily backup) or `[shorter]` | Paper downtime kit (§5) |
| Website + appointment request form | Medium | `[2 business days]` | `[24 h]` | Phone line |
| CollaborateMD billing | Medium | Vendor-dependent | Vendor | Hold claims; enter them after recovery |
| Email / fax / telehealth | High for telehealth | Vendor | Vendor | Phone sessions; backup platform `[name, if under BAA]` |

## 2. Data backup plan (R)

| Layer | What | Frequency | Retention | Encryption | Location | Status |
|---|---|---|---|---|---|---|
| L1 | Render persistent disk snapshots (`ehr-data`) | Daily (Render-managed) | Per Render `[verify]` | Encrypted at rest (HIPAA workspace) | Render | Covered by the hosting BAA |
| L2 | **EHR encrypted backups** (AES-256-GCM, `EHR_BACKUP_KEY`), verified after each run, retention pruning (implemented in this release; verify after deployment) | `[daily / N hours, per configuration]` | `[e.g. 14 daily, 8 weekly, 12 monthly]` | AES-256-GCM | `[disk path]` | Verify |
| L3 | **Off-site copy** of L2 files | `[daily / weekly]` | `[≥ 1 year]` | Already encrypted; destination also encrypted | `[e.g. S3 bucket with Object Lock in a separate account under a BAA / encrypted drive in a safe]` | **Owner action** |

Rules:
- Backups contain the full database: every patient, every note (including psychotherapy notes), and the audit log. Treat backup files as PHI even though they are encrypted.
- `EHR_BACKUP_KEY` is stored in the password manager **and** in sealed escrow at `[location]`. It is never kept in the same place as the off-site backup files.
- A failed backup raises a `backup_failed` alert on /ehr/security. Investigate it the same business day.

## 3. Restore testing (A, adopted as mandatory)
- **Quarterly**, plus after any change to the backup code or hosting.
- Procedure:
  1. Restore the latest L2 backup into a **non-production** environment with the EHR's command-line restore (see [technical-controls.md](../technical-controls.md) §4). The environment must be under a BAA, or an encrypted, practice-owned workstation.
  2. Start the app and confirm the newest records exist.
  3. Measure how long it took.
  4. Securely delete the test copy.
- **Annually**, also test restoring from an **L3** copy and an **L1** snapshot.

| Date | Source (L1/L2/L3) | Backup timestamp | Restore time | Result | By |
|---|---|---|---|---|---|
| | | | | | |

## 4. Disaster recovery plan (R)

Who declares a disaster: the Security Officer or Owner. Contact list: `[names, phones]`. Render support: `[plan support channel]`.

| Scenario | Steps |
|---|---|
| **Service down, data intact** (bad deploy, crash) | 1. Check the Render dashboard and `/healthz`. 2. Roll back to the last good deploy (Render → Deploys → Rollback). 3. If Render is having an outage, start emergency mode (§5) and watch status.render.com. |
| **Database corrupted or records deleted** | 1. Stop writes by suspending the service. 2. Preserve the damaged file for investigation. 3. Restore the latest verified L2 backup (or an L1 snapshot) with the CLI restore. 4. Re-enter any work done since the backup from the paper downtime records. 5. Treat it as a security incident. |
| **Ransomware or account compromise** | 1. Treat as a security incident and possible breach. 2. Lock down the Render and GitHub accounts: reset credentials, MFA, and sessions. 3. Rotate `EHR_DATA_KEY` per README, and `EHR_BACKUP_KEY` for future backups (keep the old key in escrow for older backups). 4. Rebuild from clean code and restore from an L3 copy taken **before** the compromise. |
| **Hosting provider unavailable long-term** | Deploy the `Dockerfile` on an alternate HIPAA-eligible host under a BAA `[pre-identified host]`. Mount a volume at `/var/data`, restore from L3, and set the same environment variables. Update DNS. |
| **Key lost** | Retrieve it from escrow. If both copies are lost, existing L2/L3 backups **cannot be restored**: take a fresh backup with a new key immediately, and fall back on L1 snapshots. |
| **Office unavailable** (fire, flood) | The EHR is cloud-hosted, so staff work remotely on approved encrypted devices (device policy). Telehealth continues. |

## 5. Emergency mode operation plan (R)
While the EHR is unavailable:
- **Downtime kit**, stored at `[location]` and electronically in `[BAA-covered storage]`:
  - paper progress-note and intake templates;
  - crisis and safety-plan forms;
  - a copy of the next `[2]` days' schedule. Export or print it daily or weekly, store it securely, and shred it after use.
- Clinicians record sessions on paper and enter them in the EHR within `[2 business days]` of recovery. The entry is marked "late entry, downtime" with the actual service date.
- Crisis protocols (988, 911, the county crisis line) don't depend on the EHR.
- Security protections stay in place during an emergency. Paper is locked away, and no PHI goes to personal email.

## 6. Testing and revision (A)
Run a tabletop exercise every year (for example, "Render account suspended on a Monday morning"). Update this plan after every test or real event.

## 7. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
