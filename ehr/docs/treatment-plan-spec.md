# Treatment Plan v2: Specification

Synthesized from five research passes covering accreditation (CARF, Joint Commission), payer and Medicaid documentation rules (Medicare LCDs, OIG audits, Optum, Magellan, Montana Medicaid), clinical best practice (problem → goal → objective → intervention, SMART, person-centered recovery planning), SUD and ASAM planning, and how behavioral health EHRs implement plans. Sources are listed at the end.

Fixed timelines and signers differ by state, payer and program, so they are **configurable**. The defaults below are conservative.

## 1. Structure

**Plan (header)**

| Field | Why |
|---|---|
| Plan type: mental health / SUD / co-occurring | SUD sections appear for SUD and co-occurring plans |
| Diagnoses: snapshot of the patient's active ICD-10 problem list at creation (primary first) | Medicare/payers: diagnosis linkage. EHR pattern: snapshot, not live |
| Client's vision / overall goal **in their own words** | CARF 2.C.2; CARF's most-missed standard |
| Strengths, needs, abilities, preferences (SNAP) | CARF 2.C.1; JC CTS.03.01.03 |
| Barriers, natural supports, family involvement (or why none) | JC CTS.03.01.05; person-centered planning |
| Services summary: type, amount, frequency, duration | Medicare LCDs; top OIG audit failure when missing |
| Modality rationale, estimated duration (sessions/time), expected outcome / capacity to benefit | LCD L34616 |
| Discharge / transition criteria; aftercare & referrals | CARF 2.C.2, 2.D; payers |
| Safety plan link (crisis safety plan note) when risk identified | CARF 2.C.4 |
| Start date, review interval (days, default 90), next review date | Configurable; Montana Medicaid is 90 days, MN SUD is 30 days |
| SUD block: level of care (indicated vs adjusted + reason), continued-stay justification, MAT/MOUD plan, drug-testing plan, relapse-prevention plan (triggers, coping, lapse response, naloxone), recovery supports | ASAM 4th ed.; TIP 42; state SUD rules |

**Problem / need** (one or more): title; behavioral definition (how it shows up for this client: frequency, duration, functional impact); linked ICD-10 code; priority; barriers. For SUD/co-occurring plans, also the ASAM dimension (1–6), a "dimensional driver" flag and stage of change.

**Long-term goal** (one or more per problem): the client's own words (verbatim), plus the clinical restatement. Goals are phrased positively, as something to move toward.

**Short-term objective** (one or more per goal), SMART:
- objective statement with one observable behavior per objective
- measure type: standardized instrument / frequency / duration / self-rating / yes-no attainment
- instrument (PHQ-9, GAD-7, PCL-5, AUDIT…) when instrument-based
- baseline value, target value, direction (decrease / increase / achieve), unit
- how and how often it is measured
- target date
- optional linked strength
- status: not started, progressing, partially met, met, not met, regressed, revised, discontinued

**Intervention** (one or more per objective):
- kind: professional service / client self-directed action / natural support
- modality or evidence-based practice (CBT, BA, CPT, DBT skills, MI, medication management, peer support…)
- the specific technique and its purpose
- frequency (e.g. weekly 53 min) and duration (e.g. 12 weeks)
- responsible person: staff member, or free text for the client, family or peer

Weak objectives to warn about: "understand", "gain insight", "feel better", "be compliant", "learn coping skills" with no measure. Use a soft warning, not a block.

## 2. Lifecycle, signatures, versions

1. **Draft:** fully editable. Only one draft per patient.
2. **Activate:** needs at least one problem → goal → objective → intervention chain, a review interval, and the signatures below. Activation sets `activated_at`, sets next review = activation date + interval, and supersedes the previously active plan in the same transaction.
   - **Clinician signature** (password re-entry). Required.
   - **Client signature** (in person / electronic / verbal) **or** a documented decline/unable-to-sign reason. Plus a "copy offered to client" flag. Required.
   - **Guardian signature**: optional; prompt for it when the patient is under 18.
   - **Supervisor co-signature**: optional by default. Make it required with env `EHR_PLAN_REQUIRE_SUPERVISOR=1`. A supervisor is a clinician or admin who isn't the author.
   - Signatures attach to that plan version. Signing locks the content.
3. **Update / revise:** "Revise plan" copies the active plan (all problems, goals, objectives, interventions, header fields) into a new **draft** with `version + 1` and `supersedes_id`. The active plan stays active until the new version is activated. Signed versions are never edited.
4. **Review:** "Start review" creates a dated review record holding:
   - per-objective status, current value, rationale and action (continue / modify / change intervention / close)
   - client perspective, participants, summary
   - diagnosis changes, and whether the level of care is still appropriate
   - outcome: **continue** pushes the next review date out by the interval; **revise** creates a revision draft; **discharge** ends the plan.
   - The reviewing clinician signs it with their password.
5. **End / complete:** reason (goals met, discharged, transferred, client withdrew, other) and an end date. The plan stays on file.

## 3. Measurement-based care (Joint Commission CTS.03.01.09)

- Instrument-based objectives pull the **latest score** for that instrument from `assessments` automatically, showing current vs baseline vs target and % progress = (baseline − current) / (baseline − target), clamped to 0–100.
- When creating an instrument objective, prefill the baseline from the most recent score.
- Flag "no reliable improvement" when 6+ weeks have passed since activation and the PHQ-9 has dropped fewer than 5 points (GAD-7: fewer than 4), so the plan should be reconsidered. This is a heuristic.

## 4. Golden thread (progress notes ↔ plan)

- Progress, group and psychiatry note forms show the active plan's objectives as checkboxes ("addressed this session"), each with a progress rating (progressing / no change / regressed / met) and a short comment. These are stored in `note_objectives`.
- The note view lists the objectives addressed. Signing a note whose type normally needs a plan (progress, group, psychiatry) while the patient has an **active plan** requires at least one addressed objective. If there's no active plan, show a warning, not a block: "No active treatment plan. Payers expect a plan before ongoing therapy."
- The plan view shows, for each objective, the count of notes that addressed it and the last date.

## 5. Alerts

- Chart banner / plan tab: "Plan review overdue" (red) or "due in ≤ 7 days" (amber).
- Dashboard: "Treatment plans due for review" for the clinician's own patients (all patients for admins).
- Chart: patients with ongoing appointments but no active plan get "No active treatment plan".

## 6. ASAM note alignment

The ASAM assessment note offers the **4th-edition** dimension names (default) with 3rd-edition names as an option, and records indicated vs adjusted level of care with the reason. 4th-edition dimensions:
1. Intoxication, Withdrawal & Addiction Medications
2. Biomedical Conditions
3. Psychiatric & Cognitive Conditions
4. Substance Use-Related Risks
5. Recovery Environment Interactions
6. Person-Centered Considerations

4th-edition levels include 1.0, 1.5, 1.7, 2.1, 2.5 and 2.7 (2.5 replaces partial hospitalization), plus residential and inpatient levels. Verify the names against the licensed ASAM text.

## 7. Privacy

SUD plans and their notes are 42 CFR Part 2 records. Show a Part 2 notice on SUD/co-occurring plans and their printouts.

## Sources (from research)

- CARF BH Section 2.C (summary): albertakids.com/carf-surveyors/section-two-general-program-standards/behavioral-health-standard-2-c-person-centered-plan/
- Joint Commission CTS sampler; CTS.03.01.09 outcome measures (digitalassets.jointcommission.org)
- CGS Psychotherapy Documentation Checklist; LCDs L34616, L35101; OIG A-02-21-01006
- Montana Medicaid BHDD Policy 120; Optum Maryland audit tool; Magellan TRR; CCA documentation standards
- Yale PRCH person-centered care planning; CT DMHAS PCRP tools; NC PCRP QI tool
- ASAM 4th ed. overviews (Mountain Plains ATTC; IRETA); LA County SAPC; MN 245G.06; FL 65D-30.0044; 42 CFR 8.12; 42 CFR Part 2 (2024 rule)
- EHR help docs: Ensora/TheraNest, ICANotes, SessionsHealth, Tebra, Valant, Kipu, TherapyNotes
