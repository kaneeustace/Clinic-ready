# Policy: Workforce Security and Sanctions

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Adapt it, complete the `[placeholders]`, and adopt it. Employment counsel should review the background-check and sanction provisions for `[State]`.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` and Security Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.308(a)(1)(ii)(C) (sanction policy), 164.308(a)(3) (workforce security), 164.308(a)(5) (training), 164.530(b), (e) |

## 1. Scope
"Workforce" means employees, contractors, volunteers, trainees, and anyone else whose work is under the practice's direct control, whether or not they are paid (45 CFR 160.103).

## 2. Before access (clearance)
1. Verify identity, licenses, and credentials for clinicians. Check the OIG exclusion list (https://exclusions.oig.hhs.gov/) and `[state Medicaid exclusion list]`. Run a background check where state law allows `[decide scope]`.
2. Sign a confidentiality agreement.
3. Complete HIPAA training ([../training/workforce-training.md](../training/workforce-training.md)) and sign the attestation **before** any account is activated.
4. Assign a role using the [role matrix](minimum-necessary-and-role-matrix.md). Create accounts, then enroll MFA.
5. Collect a BYOD acknowledgment if the person will use a personal device.

Contractors with system access, such as an IT consultant or developer, also need a **BAA** if they are not workforce members (see the vendor policy).

## 3. Supervision
Supervisors make sure their staff use only the access their role needs, follow the policies, and report incidents. Trainees' notes are reviewed and co-signed by `[supervisor]`. `[Confirm whether the EHR's addendum or supervisor-signature workflow meets licensing-board rules.]`

## 4. Termination and role change (offboarding checklist)
Complete these items **by the end of the last day**, or **immediately** for an involuntary termination.

| Step | Done (date/initials) |
|---|---|
| EHR: Admin → Users → **deactivate** (revokes all sessions) | |
| EHR: reassign or close the person's unsigned draft notes; arrange co-signature or a note from the supervisor as appropriate | |
| Render / GitHub access removed (if any) | |
| CollaborateMD, email, fax, telehealth, phone/SMS, password manager accounts removed or disabled | |
| Shared secrets they knew are rotated: door codes, shared mailbox passwords, and `EHR_BACKUP_KEY` / `EHR_DATA_KEY` if they had hosting access (see technical-controls for rotation) | |
| Practice devices, keys, badges, and paper records returned; personal devices cleared of practice data | |
| Email forwarding/auto-reply set; mailbox kept per retention | |
| Reminded of continuing confidentiality obligations | |
| Audit review of the person's access in the 30 days before departure (optional; recommended for involuntary terminations) | |

## 5. Sanctions policy (required)
Sanctions match the severity and intent of the violation. They are applied consistently, **regardless of role or seniority**, and documented. The practice won't sanction anyone for good-faith reporting of a concern, for whistleblower disclosures, or for filing a complaint with HHS (164.530(g), 164.502(j)(1)).

| Level | Examples | Typical sanctions (any level may lead to immediate termination if warranted) |
|---|---|---|
| **1. Unintentional / careless** | Leaving a screen unlocked; misdirected internal message; discussing PHI where others could overhear; failing to log out | Verbal coaching and retraining; written note in the file |
| **2. Repeated or negligent** | A repeat Level 1; sharing a password; storing PHI on an unapproved device; sending PHI to the wrong outside recipient; not reporting an incident promptly | Written warning, retraining, access review; possible suspension |
| **3. Deliberate, without harmful intent** | Looking at a family member's, coworker's, or celebrity's chart out of curiosity (**snooping**); accessing your own chart instead of using the patient-access process; bypassing controls | Final written warning or termination; access suspended during the investigation |
| **4. Deliberate, malicious or for gain** | Selling or stealing PHI; disclosing it to harm someone; identity theft; tampering with records or audit logs | Termination; report to law enforcement and licensing boards as appropriate |

Documentation: keep a record of each sanction (date, person, violation, sanction, decided by) for 6 years (164.530(e)(2)).

| Date | Workforce member | Violation summary | Level | Sanction | Decided by |
|---|---|---|---|---|---|
| | | | | | |

## 6. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
