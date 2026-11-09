# Workforce HIPAA and Security Training

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Adapt the content to the practice's adopted policies, complete the `[placeholders]`, and keep the signed attestations for 6 years.

| | |
|---|---|
| Program owner | Privacy Officer `[name]`, with the Security Officer |
| Regulatory basis | 45 CFR 164.530(b) (Privacy Rule training: each new workforce member within a reasonable period after joining, and when material policy changes occur); 164.308(a)(5) (security awareness and training); 42 CFR Part 2 (if applicable) |
| Frequency | **Onboarding:** before an EHR account is activated. **Annual refresher:** every `[month]`. **Ad hoc:** within 30 days of a material policy change, a new system, or a significant incident. **Security reminders:** `[monthly]` short email or huddle tips. |
| Free resources | HHS 405(d) awareness materials: https://405d.hhs.gov/; HHS OCR training materials: https://www.hhs.gov/hipaa/for-professionals/training/index.html |

## Part A: Onboarding (about 60–90 minutes)

### Module 1: HIPAA basics (15 min)
- What PHI is, with examples from this practice: name plus appointment, diagnosis codes, PHQ-9 scores, a website request saying "my teenager is self-harming", an insurance ID.
- Covered entity, business associate, workforce member.
- Permitted uses: treatment, payment, health care operations. Everything else needs an authorization or a specific exception.
- Why behavioral health is extra sensitive: psychotherapy notes, SUD (Part 2) records, minors, state mental-health confidentiality laws.
- Duty to report concerns, and protection from retaliation.

### Module 2: Using the Clinic Ready EHR safely (20 min, with a live demo on the demo instance)
- Your own account only. Never share passwords or sessions.
- Two-factor sign-in: enroll an authenticator app and store your recovery codes in `[password manager]`. MFA is enforced with `EHR_REQUIRE_MFA=1`; implemented in this release, verify after deployment.
- Automatic sign-out after 30 minutes idle and after 12 hours. Lock your screen anyway.
- **Everything you view is logged.** The audit log records each chart view, note, export, and failed login, and admins review it regularly. Automated alerts flag unusual access.
- **Look only at what your job requires.** Viewing your own record, a family member's, a coworker's, a neighbor's, or a celebrity's chart without a work reason is a violation, even if you never tell anyone. Use the patient-access process for your own record.
- Your role and what it can see (show the [role matrix](../policies/minimum-necessary-and-role-matrix.md)).
- Clinicians:
  - Signing requires your password and is permanent; corrections go in addenda.
  - **Psychotherapy notes** are private to you. Keep treatment-relevant information in progress notes.
  - Progress and group notes require an active, signed treatment plan.
  - The ROI note records consent, including the Part 2 flag.
- Front desk: website request inbox; check the patient's **confidential communication preferences** (contact method, voicemail OK) before calling or leaving messages.
- Billing: send only the minimum needed to CollaborateMD and payers. **Self-pay restrictions:** don't bill the plan when a patient paid in full out of pocket and asked for that.

### Module 3: Devices, email, phone, fax (15 min)
- Device requirements: encryption, screen lock, updates, remote wipe; personal-device (BYOD) rules.
- Don't download PHI unless the task requires it. Delete downloads afterward. Use no personal cloud storage.
- Email: use practice email only. Use `[encryption method]` for PHI to outside recipients. Send unencrypted email to patients only if they choose it after a warning.
- Fax: verify the number and use the cover sheet.
- Texting: no PHI by SMS except through `[approved tool]`.
- Telehealth: private room, approved platform `[name]`, verify the patient's identity and location.
- Paper: clean desk, locked storage, shred.
- Conversations: watch where you discuss patients (waiting room, phone in public).

### Module 4: Phishing and social engineering (10 min)
- How phishing looks: fake Render, GitHub, Microsoft, or Google sign-in pages; "urgent" payment requests; fake records requests.
- The EHR is only ever at `https://[your-domain]/ehr`. Check the address bar before typing your password.
- Phone pretexting ("I'm her husband, what time is her appointment?"). Verify identity and check for an authorization or personal-representative status before sharing anything.
- Report suspicious messages to `[Security Officer / report-phish address]`. Don't click first.

### Module 5: Incidents and breaches (10 min)
- What to report: lost device, wrong recipient, suspected snooping, a strange login alert, ransomware, a vendor notice.
- **Report immediately** to `[Privacy/Security Officer, phone]`. The 60-day legal clock may start when *any* workforce member knows.
- Don't try to fix it or contact the patient yourself.

### Module 6: Patient rights (10 min, front desk and clinicians)
- How to route requests for records access (30-day limit), amendment, accounting, restrictions, and confidential communications to the Privacy Officer.
- Never refuse a patient their records on your own authority.
- Minors and personal representatives: `[State]` basics.
- Part 2 consent basics, if applicable.

### Module 7: Sanctions and acknowledgment (5 min)
- Overview of sanction levels. Snooping can mean termination.
- Sign the attestation (Part C).

## Part B: Annual refresher (about 30–45 minutes)
- What changed this year: policy updates, new EHR features, new vendors, regulatory changes (Security Rule final rule status; Part 2; state law).
- Lessons from the practice's incidents and audit reviews, de-identified.
- Phishing refresher, with current examples.
- Re-confirm device compliance.
- Re-sign the attestation.

## Part C: Training attestation

I, ______________________________ (name), role ______________________, confirm that on ____________ (date) I completed the ☐ onboarding / ☐ annual HIPAA privacy and security training for Clinic Ready Behavioral Health. I confirm that:

1. I received, read, and understand the practice's privacy and security policies, including Access Control and Authentication, Minimum Necessary, Device and Media, Incident Response, Patient Rights, and Workforce Sanctions.
2. I will access, use, and disclose patient information **only as my job requires**. I understand that **all EHR activity is logged and reviewed**.
3. I will not share my passwords, MFA device, or recovery codes, and I will lock my screen when I step away.
4. I will report suspected security incidents, lost devices, and privacy violations **immediately** to the Privacy or Security Officer.
5. My devices used for work meet the device policy (encryption, screen lock, updates, remote wipe).
6. I understand that violations may lead to sanctions up to and including termination, and may carry civil or criminal penalties.
7. My confidentiality obligations continue after my employment or engagement ends.

Signature: ______________________________ Date: ____________

Trainer / Privacy Officer: ______________________________ Date: ____________

## Part D: Training record

| Name | Role | Onboarding date | MFA enrolled | Device(s) verified | Annual refresher dates | Attestation on file |
|---|---|---|---|---|---|---|
| | | | | | | |

Keep this record and the signed attestations for **6 years** (164.530(j), 164.316(b)).
