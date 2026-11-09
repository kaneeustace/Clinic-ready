# Policy: Patient Privacy Rights

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. State law may grant broader rights or shorter deadlines, especially for mental health records and minors. Counsel must add `[State]` rules, including minors' consent and access and parental access to adolescents' records. Complete the `[placeholders]` and adopt the policy. Keep it consistent with the Notice of Privacy Practices (`privacy.html` and the full NPP).

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.520 (NPP), 164.522 (restrictions, confidential communications), 164.524 (access), 164.526 (amendment), 164.528 (accounting), 164.508(a)(2) (psychotherapy notes), 164.502(g) (personal representatives) |
| Sources | HHS Individuals' Right of Access guidance: https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access/index.html; eCFR 45 CFR 164 Subpart E: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E |

> **Regulatory status note (uncertain; verify):** In 2021 HHS proposed shortening the access deadline to 15 days, among other changes. The deadlines below reflect the rule **in effect when this was drafted** (30 + 30 days). Reports in 2026 said a Privacy Rule final rule was expected. Check its status before adopting this policy, and use the shorter deadline if it has been finalized.

## 1. Designated record set
The designated record set is the set of records used to make decisions about the patient. At this practice it is:
- **EHR:** demographics, insurance, problem list/diagnoses, medications, allergies, appointments, clinical notes (intake, progress, psychiatry, contact, group, crisis safety plan, ASAM, ROI, discharge) and their addenda, treatment plans and reviews, assessments (PHQ-9, GAD-7, …), charges, payments, and superbills.
- **Billing records in CollaborateMD.**
- **`[Paper records, if any]`.**

**Excluded: psychotherapy notes** (the EHR's "Psychotherapy note (private)" type).

## 2. Right of access (164.524)
- **Requests:** written requests are preferred. The practice may require writing if the NPP says so, but can't create unreasonable barriers, such as requiring a notarized form or an in-person visit. Verify identity per `[procedure: photo ID in person / known phone call-back / portal]`. Log the request.
- **Deadline:** act **within 30 calendar days** of receipt. One **30-day extension** is allowed if the patient gets written notice within the first 30 days giving the reason and the expected date. Aim to fulfill it much sooner.
- **Form and format:** provide it in the form and format requested if it's readily producible. For electronic records, provide an electronic copy. The EHR's **right-of-access record export** (implemented in this release; verify after deployment) produces the patient's record electronically and **leaves out psychotherapy notes**. Before release, the Privacy Officer reviews it for third-party information that may be withheld only under the limited grounds below.
- **Delivery:** by the method the patient asks for, including **unencrypted email if the patient asks after being warned of the risk**. Document that warning and the patient's choice. Directing a copy to a third party also requires a signed, written request that clearly identifies the recipient.
- **Fees:** a reasonable, cost-based fee limited to labor for copying, supplies, and postage, or a flat fee of no more than $6.50 for electronic copies of electronic records, per HHS guidance. No fees for search, retrieval, or verification. `[State fee limits may be lower.]` These HIPAA fee limits apply to copies sent to the patient. After *Ciox Health v. Azar* (D.D.C. 2020), they apply only in part to records the patient directs to a third party. Counsel should confirm. Policy here: `[no charge for electronic copies]`.
- **Denial:**
  - *Unreviewable grounds* include psychotherapy notes, information compiled for legal proceedings, and certain information from confidential sources.
  - *Reviewable grounds* are where a licensed professional determines access is **reasonably likely to endanger the life or physical safety** of the patient or another person, or (for references to others) to cause substantial harm.
  - Denials must be **in writing**, give the basis, explain review rights and how to complain, and still provide whatever isn't denied. A reviewable denial is reviewed by a licensed professional who didn't take part in the original decision.
- **Information blocking:** the 21st Century Cures Act information-blocking rules (45 CFR Part 171) may also apply to electronic health information requests. Psychotherapy notes are not EHI. `[Counsel to confirm applicability.]`
- **Recording:** record the release in the disclosure log only if it went to a third party. Disclosures to the patient are exempt from the accounting. The EHR's audit log records the export.

## 3. Amendment (164.526)
- Requests must be written and give a reason (if the NPP says so).
- Act **within 60 days**, with one **30-day extension** after written notice.
- **Accept:** add an **addendum** to the affected signed note(s) in the EHR, linking the correction. Signed notes are never overwritten. Notify the people the patient names, and others known to have relied on the information.
- **Deny** (if the information wasn't created by the practice, isn't in the designated record set, isn't available for access, or is accurate and complete): send a written denial with the basis, the patient's right to file a **statement of disagreement**, and how to complain. Attach the request, denial, and any statement or rebuttal to the record, and include them with future disclosures of that information.

## 4. Accounting of disclosures (164.528)
- Patients may request an accounting of disclosures made in the **6 years** before the request.
- **Exempt from the accounting:**
  - treatment, payment, and health care operations;
  - disclosures to the patient;
  - disclosures under the patient's authorization;
  - facility directories / persons involved in care;
  - national security;
  - correctional institutions;
  - limited data sets;
  - incidental disclosures.
- **Must be logged** (in the EHR's `disclosures` table, implemented in this release; verify after deployment):
  - disclosures required by law (court orders, subpoenas with assurances);
  - abuse or neglect reports;
  - public health;
  - health oversight;
  - judicial and law enforcement;
  - threats to health or safety (duty to warn);
  - workers' compensation;
  - any impermissible disclosure, such as a breach.

  Each entry records the date, recipient (and address if known), a brief description of what was disclosed, and the purpose/basis.
- **Deadline:** 60 days, with one 30-day extension. The **first accounting in any 12 months is free**. Later ones may carry a reasonable cost-based fee if the patient was told in advance.
- Law-enforcement or oversight requests to suspend the accounting are honored per 164.528(a)(2).
- **Not the same as the access report:** the EHR's per-patient **access report** (Admin) shows *internal* views. HIPAA doesn't currently require providing it to patients, but the practice may choose to use it to answer patient concerns `[decide]`.

## 5. Requests for restrictions (164.522(a))
- Patients may ask the practice to limit uses and disclosures for TPO, or to family members. The practice **may decline**, **except** for this case: the practice **must agree** not to disclose to a **health plan** for payment or operations PHI about a service the patient (or someone other than the plan) **paid for in full out of pocket**, unless law requires the disclosure.
- Agreed restrictions are recorded `[in the patient chart: flag/alert field, or a pinned contact note titled "PRIVACY RESTRICTION"]` and communicated to billing, so that self-pay visits are **not** sent to CollaborateMD or the payer. *(The EHR doesn't have a dedicated restriction flag. Use `[chosen method]` and add a manual check before claims export.)*
- The practice may end an agreed restriction (other than the self-pay restriction) by telling the patient, effective for PHI created afterward.

## 6. Confidential communications (164.522(b))
- **Must accommodate reasonable requests** to receive communications by alternative means or at alternative locations: a different phone, no voicemail, a different mailing address, email only. Don't ask why.
- The EHR captures **preferred contact method** and **OK to leave voicemail** on website requests. Record the patient's choice in the chart demographics/contacts and **check it before every call, voicemail, text, mailing, or statement**. This matters especially for adolescents and for patients at risk of domestic violence.

## 7. Psychotherapy notes
- **Definition (164.501):** notes recorded by a mental health professional documenting or analyzing the contents of a counseling session, **kept separate from the rest of the record**. Medication prescribing and monitoring, session start/stop times, modalities and frequency, clinical test results, and summaries of diagnosis, functional status, treatment plan, symptoms, prognosis, and progress are **not** psychotherapy notes.
- **In this EHR:** the "Psychotherapy note (private)" type is stored separately in practice. Only its author can view it; admins and other clinicians can't. It's left out of chart note lists for others and out of the right-of-access export. Attempts to open it are denied and audited.
- **Use and disclosure:** most uses and disclosures require a **specific authorization** that is separate from other authorizations (164.508(a)(2)). Exceptions include the author's own treatment use, the practice's supervised training programs, defending the practice in a legal action brought by the patient, HHS compliance, and certain required-by-law or health oversight uses.
- **Patients have no HIPAA right of access** to psychotherapy notes. The clinician may choose to share them. `[State law may grant access; counsel to confirm.]`
- **Workforce rule:** document diagnosis, risk, interventions, and progress in a **progress note** (the EHR shows this reminder). Never put information needed for treatment or billing only in a psychotherapy note.

## 8. Notice of Privacy Practices (164.520)
- Give the NPP at the first service delivery and make a good-faith effort to get a written acknowledgment. Post it in the office and on the website, and give a copy on request.
- Revise it for material changes. **If Part 2 applies, the NPP had to be updated for the 2024 Part 2 rule by 2026-02-16.** See [part2-substance-use-records.md](part2-substance-use-records.md).
- **Counsel review required:** the website summary on `privacy.html` is marked as a template and has placeholders, including the Privacy Officer's contact details.

## 9. Personal representatives and minors
- Parents or guardians of minors, holders of health care power of attorney, and executors are generally treated as the patient. **Exceptions:**
  - when a minor may consent to their own care under state law;
  - when the practice reasonably believes the representative may be abusing the patient and treating them as the patient could endanger the patient (164.502(g)(5)).
- `[State]` minor-consent age for outpatient mental health: `[ ]`; SUD treatment: `[ ]`. Parental access rules: `[counsel]`.

## 10. Complaints and non-retaliation
Direct complaints to the Privacy Officer at `[contact]`. Log them in `[complaint log]`, respond in writing within `[30]` days, and keep them for 6 years. Patients may also complain to HHS OCR (https://www.hhs.gov/ocr/complaints). Never retaliate against anyone who complains. Never require patients to waive their rights as a condition of treatment.

## 11. Request log (all rights requests)

| Date received | Patient (MRN) | Right (access/amend/accounting/restriction/conf. comms) | Due date | Extension? | Outcome | Date completed | Handled by |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 12. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
