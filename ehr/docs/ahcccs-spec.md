# AHCCCS (Arizona Medicaid) Documentation and Billing: Implementation Spec

Built from research on AHCCCS primary sources, downloaded 2026-11-09:
- AMPM 940 (Medical Records)
- AMPM 320-O (Assessments, Service and Treatment Planning)
- AMPM 320-I (Telehealth)
- the Covered Behavioral Health Services Guide (CBHSG, effective 10/1/2026)
- the B2 BH Services Matrix
- the Telehealth Code Set
- the Medical Coding Resource Guide
- the FFS Provider Billing Manual Chapter 19
- the AHCCCS BH Claim Documentation Technical Errors Workshop (3/2025)
- the BHCCA audit guide
- A.A.C. R9-10-1011

AHCCCS updates its code tables every quarter or year, so treat codes and modifiers as configuration and re-verify them against the current B2 Matrix and Telehealth Code Set.

**When it applies:** `src/payers.js` `isAhcccs(db, patientId)` is true only for patients with an AHCCCS ID on file. AHCCCS-only fields are hidden for everyone else (values already recorded stay visible). If an AHCCCS health plan is on file without an ID, the Insurance card reminds staff to add the ID.

## A. Progress / encounter notes (AMPM 940 §4.l; CBHSG core limitations)

Every note for an AHCCCS member must capture the following. Required means required to sign.

1. **Actual start and stop times** for this member (940 4.l.viii; CBHSG #7). No templated or schedule-based times. Required on all billable note types.
2. **Service type**: individual / family (member present) / family (member absent) / group (940 4.l.v–vi). Group means the HQ modifier.
3. **Diagnosis addressed**, with status **new** or **continuing from the current assessment** (940 4.l.vii).
4. **Place of service / member location**. For telehealth, this is where the member was (office 11, home 12, school 03, other 99). AHCCCS does **not** use POS 02/10.
5. **Telehealth**:
   - modality: **audio-video (GT)** or **audio-only (FQ)** (940 2.m; Telehealth Code Set)
   - member's location
   - telehealth informed consent on file (ARS 36-3602; 320-I)
   - for audio-only: why video wasn't available, and the session must run over 10 minutes
6. **Participants present**, with each person's role (family or caregiver involvement; multiple providers need their roles and the reason each was needed, per 940 4.l.xvi).
7. **Interpreter / language**:
   - preferred language
   - interpreter: not needed / offered and declined / provided (with interpreter name or ID)
   - Scored as BHCCA PC-2/PC-3.
8. **Goals addressed**, linked to the Service/Treatment Plan (940 4.l.xii). This is the existing golden-thread objectives list.
9. **Interventions / treatment methods used** (940 4.l.xii; evidence-based for counseling).
10. **Member's individualized response** (940 4.l.xiv) and **progress toward objectives** (4.l.xiii).
11. **Counseling content** (CBHSG Counseling #5):
    - presenting problem / reason for the session, as listed in the service plan
    - brief mental status / appearance
    - screener results (link the latest PHQ-9/GAD-7/etc. or enter them)
    - sessions over 60 minutes need a justification
12. **Plan / next steps**, including coordination of care with the PCP or other providers when it happens (940 2.l).
13. **Signature**:
    - unique e-signature, credential, exact date **and time** (940 2.f; ARS 44-7031)
    - already implemented: password signing, credentials and timestamp
    - the signature line must show the credential and the time
14. **Timeliness / late entry**:
    - Notes signed more than 48 hours after the end of the service must carry a **late entry** flag, a reason, and the date/time of the late entry (940 2.g, 2.i).
    - Post-signature changes are addenda (already implemented).
15. **No cloned notes** (940 2.h; denial edit MD435). Warn if the narrative sections are identical, or nearly identical (normalized text match), to another note for the same patient by the same author.
16. **One note per billed service** (940 4.l.xvii). If a note supports multiple codes, each needs its own description.
17. **Case management** (T1016): a separate note type, never combined with therapy. Voicemail or email must be substantive, and leaving a voicemail requires the member's signed consent (on the patient record: `ok_voicemail`).

## B. Assessment (AMPM 320-O §F; R9-10-1011)

The intake assessment must include all of the following:
- presenting concerns
- member and family strengths and needs
- behavioral health and medical treatment history
- **trauma history**
- family behavioral and medical history
- substance use (type, route, frequency, duration)
- **social determinants** (housing, education/vocation, employment, social and cultural)
- **developmental history**
- **criminal justice history / pending litigation**
- public and private **resources**
- **legal status** (custody, guardian, decision-maker, capacity)
- **SMI special-assistance need**
- **language and communication**
- risk assessment
- mental status exam
- clinical impressions
- recommendations and next steps
- diagnostic impressions
- need for further or specialty evaluation
- diagnosis
- services to be provided
- level-of-care tool: **CALOCUS** for ages 6–17 (at intake, then every 6 months); **ASAM** for adults with a substance use disorder

Rules:
- Only a licensed BHP or BHMP may give a diagnosis.
- An assessment done by a BHT or RN must be **reviewed and signed by a licensed BHP within 72 hours**.
- The assessment must be documented within 48 hours of completion.
- Update **at least annually** and after significant life events: hospitalization or crisis, housing change, death, family change, incarceration, level-of-care change, diagnosis change, major illness.
- The record must show the assessment was **shared with the PCP / Health Home** at start and at each update.

## C. Service / Treatment Plan (AMPM 320-O §G/§H)

AHCCCS calls the comprehensive plan the **Service Plan** and specialty plans **Treatment Plans**. Required contents:
- measurable goals reflecting the member's own definition of achievement
- services for each assessed need, with frequency and duration, using B2 Matrix service names
- strategies
- who is responsible for each service
- a schedule
- court-ordered treatment, if any
- crisis contacts
- a trauma-informed **safety plan**
- the member's chosen team (Child and Family Team / Adult Recovery Team)
- a documented **offer of a peer or family support partner**

Rules:
- The plan **must be no more than 1 year old on the date of service**, or the claim is denied (edit MD466). Default review interval for AHCCCS plans: 365 days, with "update after significant life events" prompts. The existing 90-day setting is allowed as stricter.
- **Members under 18: a parent or guardian signature is required** (edit MD454). For AHCCCS this is a blocking error at activation, not a warning.
- SMI members: record agreement or disagreement with the plan (320-O Attachment A).

## D. Billing (CBHSG; B2 Matrix; Telehealth Code Set; MCRG; FFS Chapter 19)

**Codes to add to the fee schedule** (fees are placeholders):
- H0004: BH counseling, per 15 minutes
- H0031: MH assessment by a non-physician (full intake, annual reassessment, CALOCUS/ASAM only)
- H2014: skills training, per 15 minutes
- H2017: psychosocial rehabilitation, per 15 minutes
- H0038: peer support, per 15 minutes
- T1016: case management, per 15 minutes
- Existing CPT codes stay (90791, 90792, 90832–90838, 90846, 90847, 90853).
- 90839/90840/90785 are **not** confirmed for AHCCCS; flag them if used.

**15-minute units**: `unitsFor15(minutes)`. Under 8 minutes = 0 (not billable); 8–22 = 1; 23–37 = 2; 38–52 = 3; 53–67 = 4; and so on. Charge units must match the documented minutes (edit MD418).

**Modifiers (AHCCCS only)**:
- **Telehealth**: GT = audio-video, FQ = audio-only. Never 95 or 93 for AHCCCS-only members. Exactly one telehealth modifier. FQ is not allowed on E/M codes.
- **POS**: the member's location (11/12/03/99). Not 02/10 unless another primary payer requires it.
- **Group**: HQ whenever 2 or more members are served. Max 15 members (1:20 for in-person H2014/H2017/H0038).
- **Family (H0004)**: HR = member present, HS = member absent.
- **Education level** for BHT/BHPP/associate-level staff: HM (less than bachelor), HN (bachelor), HO (master), HP (doctoral). Derived by `educationModifier(user)` from credentials, or from `users.education_level`. Validate code/modifier pairs against the B2 Matrix (e.g. H0004 allows HN/HO only).

**Who bills**:
- Independently licensed BHPs bill CPT under their own NPI.
- Associate-level BHPs, BHTs and BHPPs bill HCPCS only, under the facility NPI, with the rendering individual's name in Box 19 / loop 2300 NTE. No "incident-to" billing.
- H0038 requires the PRSS credential.

**Charge-time checks for AHCCCS members**:
- the note is signed
- the note's service type and code match (HQ on group)
- the telehealth modifier matches the note modality
- POS matches the member location
- units match minutes
- a current plan (≤ 1 year) and assessment (≤ 1 year) exist on the date of service
- a minor's plan has a guardian signature
- the diagnosis on the charge is on the note/plan
