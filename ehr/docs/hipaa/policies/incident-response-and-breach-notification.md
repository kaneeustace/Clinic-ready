# Policy: Security Incident Response and Breach Notification

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. **Contact counsel as soon as a possible breach is identified.** State breach laws can add shorter deadlines, attorney-general notice, or broader definitions; counsel must add `[State]` requirements. Complete the `[placeholders]` and adopt the policy.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` (breach determination and notification); Security Officer `[name]` (technical response) |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.308(a)(6) (security incident procedures); 164.400–414 (Breach Notification Rule); 164.530(f) (mitigation); 42 CFR 2.16 (Part 2 breach notification, 2024 rule) |
| Sources | HHS Breach Notification Rule: https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html; HHS breach reporting portal: https://ocrportal.hhs.gov/ocr/breach; eCFR 164 Subpart D: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-D |

## 1. Definitions
- **Security incident:** an attempted or successful unauthorized access, use, disclosure, modification, or destruction of information, or interference with system operations (164.304). Examples:
  - a `failed_logins` alert, a phishing email, or a lost laptop;
  - a misdirected fax;
  - a chart opened without a work reason;
  - an `audit_chain_broken` alert;
  - ransomware.
- **Breach:** acquisition, access, use, or disclosure of PHI that the Privacy Rule doesn't permit and that compromises its security or privacy (164.402). **An impermissible use or disclosure is presumed to be a breach** unless one of these applies:
  - (a) A statutory exception:
    - unintentional, good-faith access by a workforce member acting within their authority, with no further impermissible use;
    - an inadvertent disclosure between people authorized at the practice or its BA;
    - a good-faith belief that the recipient couldn't have retained the information.
  - (b) The practice documents a **low probability that the PHI was compromised**, using the 4-factor assessment in §4.
- **Unsecured PHI:** PHI not encrypted or destroyed according to HHS guidance (https://www.hhs.gov/hipaa/for-professionals/breach-notification/guidance/index.html). Losing PHI that was **properly encrypted**, where the key wasn't also compromised, is not a reportable breach. Examples are the AES-256-GCM backups (if `EHR_BACKUP_KEY` stayed safe) and a FileVault/BitLocker laptop that was powered off.
- **Discovery:** the first day the breach is known to the practice, **or would have been known with reasonable diligence**, to any workforce member or agent other than the person who committed it (164.404(a)(2)). **The 60-day clock starts here**, not when the investigation ends.

## 2. Reporting (all workforce)
Report any suspected incident **immediately**, and **no later than `[same business day]`**, to the Privacy or Security Officer at `[phone]` / `[email]`. Don't investigate on your own, delete evidence, or contact the affected patient first. Good-faith reporting is never sanctioned.

## 3. Response steps

| Step | Action | Who | EHR / system specifics |
|---|---|---|---|
| 1. Log | Open a row in the incident log (§7) with date/time of discovery and reporter | Privacy Officer | |
| 2. Contain | Stop the exposure. Revoke access, recall or confirm deletion of misdirected material, remotely wipe devices, rotate credentials. | Security Officer | Deactivate the user (revokes sessions); reset passwords/MFA; rotate Render/GitHub credentials; rotate keys if exposed (see technical-controls) |
| 3. Preserve | Save evidence | Security Officer | Export the relevant audit rows (Admin → Audit log → CSV, filtered by user/MRN); take a snapshot or backup **before** remediation; save the /ehr/security alert detail; save Render logs/events |
| 4. Assess | Was PHI involved? Was it unsecured? Does an exception apply? If not, run the **4-factor assessment** (§4). Involve counsel. | Privacy Officer + counsel | Patient access report shows who viewed which charts |
| 5. Decide | Breach or not. Document the reasoning either way. | Privacy Officer | |
| 6. Notify | Per §5, within the deadlines | Privacy Officer | Patient contact info from the chart; honor confidential-communication preferences where possible |
| 7. Mitigate | Reduce harm: credit monitoring where SSN or financial data were involved `[decide]`, retrieve the information, retrain or sanction | Privacy Officer | |
| 8. Learn | Root cause; update the risk register, policies, training | Both officers | |

**Business associates:** BAAs require vendors to report breaches to the practice. HIPAA allows them up to 60 days from discovery (164.410); `[BAAs should require faster notice, e.g. 5–10 business days]`. The practice's own 60-day clock starts when the BA's breach is discovered **if the BA is acting as the practice's agent**. Counsel should confirm agency status for each vendor.

## 4. Breach risk assessment: the 4 factors (164.402(2))
Complete this for every impermissible use or disclosure that doesn't fit an exception. If the analysis doesn't show a **low probability of compromise**, notify.

| Factor | Questions | Finding |
|---|---|---|
| **1. Nature and extent of the PHI** | What types of identifiers (name, DOB, SSN, insurance ID, address)? How sensitive is it clinically? In a behavioral health practice almost everything is sensitive: diagnoses, psychotherapy notes, SUD (Part 2) records, suicide risk, minors. How many people? Could it be re-identified? | |
| **2. The unauthorized person** | Who used or received it? Another covered entity or BA bound by HIPAA (lower risk)? A workforce member? A family member, an abuser, the public, an unknown party? | |
| **3. Was the PHI actually acquired or viewed?** | Evidence such as audit logs showing the record was or wasn't opened, forensic analysis, a fax recipient's confirmation that they didn't read it | |
| **4. Extent of mitigation** | Signed attestation of destruction or non-use from the recipient, successful remote wipe, credentials rotated before use | |
| **Conclusion** | ☐ Low probability of compromise; no notification required. Document and retain. ☐ Notification required. | |
| Assessed by / date / counsel consulted | | |

## 5. Notification requirements and timeline

| Who to notify | When | How | HIPAA cite |
|---|---|---|---|
| **Affected individuals** | **Without unreasonable delay, and no later than 60 calendar days after discovery.** 60 days is an outer limit, not a safe harbor. | First-class mail to the last known address, or email if the person agreed to electronic notice. Next of kin or personal representative if the person has died. **Urgent** situations: also by phone. **Substitute notice** if contact information is out of date: fewer than 10 people → alternative written, phone, or other notice; 10 or more → conspicuous website posting for 90 days **or** major print/broadcast media in the area, **plus** a toll-free number active for at least 90 days. | 164.404 |
| **Media** | Breaches involving **more than 500 residents of a single State or jurisdiction**: within the same 60-day limit | Prominent media outlets serving that State/jurisdiction (typically a press release) | 164.406 |
| **HHS (OCR)** | **500 or more individuals:** contemporaneously with individual notice, and within 60 days of discovery. **Fewer than 500:** log it, and submit all such breaches **within 60 days after the end of the calendar year** in which they were discovered. | HHS breach portal: https://ocrportal.hhs.gov/ocr/breach (one submission per breach) | 164.408 |
| **State** | `[State law: deadline, AG/regulator notice, content]` | `[counsel]` | State law |
| **Part 2 records** | Since the 2024 Part 2 final rule, the HIPAA breach notification requirements also apply to breaches of Part 2 records (compliance date 2026-02-16) | Same as above | 42 CFR 2.16 |

**Law-enforcement delay:** if law enforcement says notice would impede an investigation, delay as directed: for the period in a written statement, or up to 30 days after an oral statement, which must be documented (164.412).

**Content of the individual notice** (plain language, 164.404(c)):
1. What happened, including the date of the breach and the date of discovery, if known.
2. The types of PHI involved (for example name, DOB, diagnosis, insurance ID).
3. Steps individuals should take to protect themselves.
4. What the practice is doing to investigate, mitigate harm, and prevent recurrence.
5. Contact procedures, which must include a toll-free number, email address, website, or postal address.

Template letter: `[counsel to provide]`.

**Burden of proof:** the practice must be able to show that all required notices were made, or that the event wasn't a breach (164.414). Keep all documentation for **6 years**.

## 6. Timeline worksheet

| Milestone | Date |
|---|---|
| Incident occurred | |
| **Discovered (day 0)** | |
| Counsel contacted | |
| Containment complete | |
| Risk assessment complete | |
| **Day 60 (outer deadline)** | |
| Individuals notified | |
| Media notified (more than 500 in a State) | |
| HHS notified (500+ now; fewer than 500 by **March 1** of the following year, or Feb 29 in a leap year; confirm the date on the portal) | |
| State notices | |

## 7. Incident and breach log (template)
Keep this as a restricted spreadsheet at `[location]`. It contains PHI only to the extent needed (use the MRN rather than names where possible).

| # | Date discovered | Reported by | Description (no unnecessary PHI) | Systems (EHR / email / fax / device / vendor) | PHI involved? | # individuals | Unsecured? | Exception applies? | 4-factor result | Breach? (Y/N) | Individuals notified (date) | Media (date/N/A) | HHS (date / annual log year) | State (date/N/A) | Root cause | Corrective action | Closed (date) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | |

## 8. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
