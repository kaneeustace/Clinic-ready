# Policy: Substance Use Disorder Records (42 CFR Part 2)

> **TEMPLATE: REVIEW REQUIRED, COUNSEL MUST DECIDE APPLICABILITY.** This is not legal advice. Whether 42 CFR Part 2 applies to this practice is a legal determination that depends on facts only the practice knows (§1). The summary of the 2024 final rule below is drawn from the Federal Register notice and HHS materials. Before relying on it, counsel should check it against the current eCFR text. Complete the `[placeholders]` and adopt the policy.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 42 CFR Part 2, as amended by the final rule *Confidentiality of Substance Use Disorder (SUD) Patient Records*, 89 FR 12472 (Feb. 16, 2024). The rule took effect 2024-04-16, and **compliance was required by 2026-02-16**. |
| Sources | Federal Register: https://www.federalregister.gov/documents/2024/02/16/2024-02544/confidentiality-of-substance-use-disorder-sud-patient-records; eCFR 42 CFR Part 2: https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2; HHS Part 2 page: https://www.hhs.gov/hipaa/for-professionals/regulatory-initiatives/index.html |

## 1. Does Part 2 apply? (Counsel to complete)
Part 2 applies to records from a **"Part 2 program"**: a federally assisted program that **holds itself out** as providing, and provides, SUD diagnosis, treatment, or referral for treatment (42 CFR 2.11, 2.12).

- **Federally assisted** includes, among other things, Medicare/Medicaid participation, DEA registration (for example, a prescriber registered to prescribe controlled substances such as buprenorphine), federal grants, or tax-exempt status.
- **Holds itself out** includes advertising SUD services. The website's `services.html` should be reviewed for this, as should any listing as an SUD provider or any state SUD license.
- A general mental health practice that treats co-occurring SUD **without** holding itself out may not be a Part 2 program. Even so, it may **receive** Part 2 records from other programs, and those records stay protected in its hands (as a "lawful holder" or recipient).

| Question | Answer |
|---|---|
| Does the practice accept Medicare/Medicaid, or does any prescriber hold DEA registration? | `[ ]` |
| Does the practice advertise or hold itself out as providing SUD treatment (website, directories, state license)? | `[ ]` |
| Is there an identified SUD unit or clinicians whose primary function is SUD treatment? | `[ ]` |
| Does the practice receive SUD records from Part 2 programs? | `[ ]` |
| **Counsel's determination** | ☐ Part 2 program ☐ Not a program but a recipient/lawful holder ☐ Not applicable. Date: `[ ]` |

## 2. How the EHR supports Part 2 handling
- **Plan type** on treatment plans: mental health / **SUD** / co-occurring. SUD and co-occurring plans include ASAM level of care, MAT/MOUD, drug testing, and relapse prevention.
- **ASAM level of care assessment** note type.
- **ROI / consent note:**
  - has a required field, "**Includes substance use disorder records (42 CFR Part 2)?**";
  - records consent method, signer, expiry, and revocation;
  - when the field is "yes", shows a reminder that the disclosure needs the redisclosure notice and a Part 2-compliant consent.
- **Disclosure log** (`disclosures.includes_part2`; implemented in this release; verify after deployment) flags each disclosure that includes Part 2 records, and can link to the ROI consent note.
- **Gap:** the EHR doesn't segment or tag individual notes as Part 2. If the practice is a Part 2 program, decide whether the **whole record** of SUD patients is treated as Part 2 (the simplest and safest choice) `[decide]`, and how Part 2 data is kept out of releases that lack Part 2 consent.

## 3. Key requirements under the 2024 rule (summary; verify against the eCFR)

| Topic | What the rule now says (summary) | Practice procedure |
|---|---|---|
| **Consent for TPO** | A patient may give a **single consent for all future uses and disclosures for treatment, payment, and health care operations** (42 CFR 2.31, 2.33). | Use the counsel-approved Part 2 consent form. Record it as an ROI note with the Part 2 field set to "yes". |
| **Redisclosure by HIPAA entities** | Covered entities and business associates that receive Part 2 records under a TPO consent may **redisclose them as HIPAA permits**, except for use in proceedings against the patient. | Billing via CollaborateMD under TPO consent is permitted. Confirm CollaborateMD's BAA covers Part 2 (it acts as a qualified service organization/BA). |
| **Consent content** | Part 2 consents must contain the elements in 2.31: patient name, the specific person or class of recipients, a description of the information, purpose, right to revoke, expiration, signature/date, and required statements. They are now more closely aligned with HIPAA authorizations. | Counsel reviews the form. |
| **SUD counseling notes** | A new category, similar to psychotherapy notes: a Part 2 clinician's separate notes analyzing a counseling session. Using or disclosing them requires **separate, specific consent** that can't be combined with other consents. | Store them only in the EHR's private "Psychotherapy note" type. Never release them without separate consent. |
| **Legal proceedings** | Records (and testimony about them) can't be used or disclosed in civil, criminal, administrative, or legislative proceedings against the patient without **specific consent or a court order** that meets subpart E. | Send every subpoena or legal request touching SUD records to the Privacy Officer **and counsel**. A subpoena alone is not enough. |
| **Notice with each disclosure** | A disclosure made with patient consent must be accompanied by the required **notice/statement prohibiting improper redisclosure** (42 CFR 2.32), or a copy of the consent. | Attach the 2.32 statement `[insert counsel-approved text]` to every Part 2 disclosure (cover sheet, email footer, export). |
| **Breach notification** | The HIPAA Breach Notification Rule's requirements now apply to breaches of Part 2 records (2.16). | Follow [incident-response-and-breach-notification.md](incident-response-and-breach-notification.md). |
| **Patient notice** | Part 2 programs must give a patient notice aligned with the HIPAA NPP (2.22). HIPAA covered entities that receive or maintain Part 2 records had to update their **NPP** by 2026-02-16. | Counsel updates the NPP and `privacy.html` (the website already has a Part 2 summary paragraph). |
| **Patient rights** | Rights to an **accounting of disclosures** made with consent (applied to TPO disclosures through an EHR once HHS finalizes the HITECH accounting rule; **status uncertain, verify**) and to **request restrictions** on disclosures for TPO. | Log disclosures in the EHR disclosure log, with the Part 2 flag. |
| **Complaints and penalties** | Patients can file complaints with HHS. HIPAA civil and criminal penalty structures apply to Part 2 violations. | Same complaint process as HIPAA. |
| **Segregation** | Recipients are not required to segregate Part 2 records received under TPO consent. | Practice decision in §2. |
| **De-identified data** | Can be disclosed for public health if de-identified per the HIPAA standard. | Rare for this practice. |

## 4. Procedures
1. **Intake:** for patients receiving SUD services, give the Part 2 notice (if applicable), offer the TPO consent, and record the consent as an ROI note.
2. **Before every external disclosure** of an SUD patient's records:
   1. Confirm a valid consent exists, or another Part 2 exception applies (medical emergency, research, audit/evaluation, court order under subpart E, or a qualified service organization agreement).
   2. Release only what the consent covers.
   3. Attach the 2.32 notice.
   4. Log the disclosure with the Part 2 flag.
   5. Have a second person verify the recipient (fax number or address) `[recommended]`.
3. **Revocation:** record it on the ROI note's revocation field (date and how). Stop future disclosures.
4. **Medical emergency:** disclosure to medical personnel is allowed to the extent needed for a bona fide emergency where consent can't be obtained. Document the details required by 2.51 promptly.
5. **Legal requests:** never respond without counsel.

## 5. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
