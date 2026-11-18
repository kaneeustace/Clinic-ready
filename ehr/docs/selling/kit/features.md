# ChartReady Features

What ChartReady does today, by area. If something isn't on this list, assume it isn't built yet. The last section lists the most common requests that are not available.

---

## Patients and the chart

- Patient search, demographics, contacts, insurance, allergies and medications.
- ICD-10 problem list, with common behavioral health codes ready to pick.
- Duplicate-patient detection.
- Chart tabs: Overview, Appointments, Notes, Treatment plan, Measures, Billing, Level of care, Pictures.
- The chart banner shows the client's photo, current level of care and any safety flags.

## Scheduling

- Week and day calendars for each clinician.
- Conflict detection and recurring weekly series.
- Check-in, complete, no-show and cancel (with reasons).
- Telehealth links stored on the appointment.
- Colors for each appointment type, set by the clinic (Administration → Appointment colors).

## Clinical notes

- Note types: intake, progress (DAP or SOAP), group, psychiatry, contact, discharge, crisis safety plan, ASAM assessment, release of information (ROI), supportive housing and psychotherapy notes.
- Structured mental status exam and risk assessment.
- Notes are checked for required fields before they can be signed.
- Signing requires re-entering your password. Signature lines show credentials, date and time.
- Signed notes can't be edited. Corrections go in dated addenda.
- Psychotherapy notes are visible only to the clinician who wrote them, administrators included.

## Treatment plans and the golden thread

- Problems, goals, measurable objectives and interventions.
- Plan status: draft, active, superseded or completed, with review dates.
- Signatures from the clinician, client, parent or guardian, and (optionally, by clinic setting) a supervisor. Signing locks the plan; revisions create a new version.
- **Golden thread:** when a client has an active plan with objectives, each session note must say which objectives it addressed. The plan shows how many notes addressed each objective.
- **Plan gate:** progress and group notes can't be started, or signed, without a signed, active treatment plan. Intake, crisis, ASAM and other assessment notes are never blocked.

## AHCCCS (Arizona Medicaid) documentation

These fields and checks apply only to clients with an AHCCCS ID on file. Everyone else sees a normal note.

- Actual start and stop times for the session.
- Service type: individual, family (member present or absent), or group.
- Diagnosis addressed, marked new or continuing.
- Place of service / member location, and telehealth modality (audio-video or audio-only, with a reason for audio-only).
- Participants present and their roles; preferred language and interpreter use.
- Interventions, the member's response and progress toward objectives.
- Screener results prefilled from the chart.
- Justification required for sessions over 60 minutes.
- **Late entry:** notes signed more than 48 hours after the session must carry a late-entry reason.
- **Cloned-note warning:** flags a narrative that is identical or nearly identical to an earlier note by the same clinician for the same client.
- Intake assessment fields required by AHCCCS (trauma history, social determinants, developmental history, legal status and more), plus CALOCUS for ages 6 to 17 and ASAM for adults with a substance use disorder.
- A minor's treatment plan requires a parent or guardian signature before it can be activated.

AHCCCS updates its code tables regularly. Codes and modifiers should be re-checked against current AHCCCS publications.

## Insurance compliance review (AI-assisted)

- **Check insurance compliance** button on billable notes (progress, group, psychiatry, intake, discharge).
- Rule-based checks always run: time versus billing code, required elements, treatment plan linkage.
- An AI review then compares the note against payer documentation expectations and returns findings. Nothing is changed automatically.
- **Note scanner:** upload a PDF note (from another system, scanned or handwritten), choose commercial, Medicare, Medicaid or AHCCCS rules, and get the same findings. The PDF is sent for review and discarded, never stored.
- The AI step is off until the clinic turns it on, and must not be used with real patient data until a BAA with the AI provider is signed.

## Signature deadlines and supervision

- Each clinician signs their own note within a set time after the session (default 24 hours).
- Notes by clinicians who aren't independently licensed (for example BHT, BHPP, associate-level licenses), or anyone an administrator marks as needing co-signature, go to their supervisor for co-signature (default within 48 hours of the clinician's signature).
- Each user can be assigned a clinical supervisor.
- **Dashboard workboard:** To do (sessions with no note), In progress (drafts, notes awaiting co-signature, supervisees' notes to co-sign), Done (last 7 days). Each item shows a live countdown and turns red when overdue.
- **End-of-day note emails:** each clinician gets an email before they leave (default 4:30 PM, Monday to Friday) with counts of notes to write, drafts to sign and co-signatures owed, plus a sign-in link. No patient information. Staff can turn it off on their Account page.

## Level of care, utilization review and census

- Level of care tab on each chart: current level, ASAM level and program, step-up and step-down history with reasons, and discharge.
- Payer authorizations with days or sessions used, next utilization review date and expiry alerts.
- A signed ASAM assessment that recommends a different level is flagged.
- **Census page:** who is at each level on any date, admissions and discharges, and reviews due.
- The dashboard lists utilization reviews due in the next 3 days.

## Measurement-based care

- Instruments: PHQ-9, GAD-7, C-SSRS, AUDIT, DAST-10, PCL-5, MDQ, ASRS v1.1.
- Exact scoring and severity bands; trend charts with response and remission indicators.
- PHQ-9 item 9 (self-harm) safety flags show on the chart header and the dashboard.

## Client check-in

- **Phone check-in** at the clinic's check-in page: last name plus date of birth for today's appointment, or a link sent from the appointment page.
- Steps: confirm or update contact details (held for staff review), add new insurance with card photos, PHQ-9 and GAD-7 when not done in the last 14 days, and a typed consent signature.
- A positive self-harm answer shows crisis resources to the client and alerts staff.
- **Automatic check-in links** go out before each appointment (default 60 minutes) by email or text, using the client's preferred contact method. Texts and emails contain the clinic name and a link only.
- **Returning clients** (checked in within 30 days) get a one-tap "Welcome back" check-in.
- **Kiosk mode:** a front-desk iPad becomes a check-in kiosk (Schedule → Check-ins → Set up a kiosk) and resets itself between clients.
- **Check-ins page:** today's check-ins, a roster card for each group session ("3 of 5 here") and contact changes to review.

## Patient pictures

- Pictures tab on every chart: profile photo (shown in the chart banner), photo ID, insurance cards and other images.
- Pictures are resized and have location data removed before upload, are shown only to signed-in staff, and every view, upload and delete is logged.

## Billing

- Fee schedule (CPT and HCPCS codes such as H0004, H2014, H2017, H0038, T1016).
- Charges from completed visits, and a work queue of visits not yet charged.
- 15-minute unit calculation for timed codes.
- AHCCCS charge checks: signed note, service type and code match (HQ for group), telehealth modifier matches the note, place of service matches the member location, units match minutes, current plan and assessment, guardian signature for minors, diagnosis on the note or plan. Codes not confirmed for AHCCCS are flagged.
- Claim status workflow, payments and adjustments, and a patient ledger with a running balance.
- Printable superbills with the clinic's name, logo, address, NPI and tax ID.

## Website intake

- If you use the companion clinic website, its appointment request form feeds an Intake requests inbox in ChartReady.
- Spam protection (honeypot and rate limit), duplicate matching, and one-click conversion of a request into a patient.

## Records, privacy and disclosures

- **Record export (right of access):** produces a copy of a client's designated record set as a printable page or a data file, leaving out psychotherapy notes. Every export is logged.
- **Accounting of disclosures:** log each release (recipient, purpose, legal basis, method) and print the client's accounting.
- Release of information note type with consent details, expiry and revocation. A 42 CFR Part 2 redisclosure notice appears when substance use records are involved.
- Per-client access report showing which staff viewed the chart.

## Administration and security

- Four roles: Admin, Clinician, Front desk, Billing. Each sees only what the role needs.
- Password policy (12+ characters, 3 of 4 character types), lockout after 5 failed attempts, and password resets.
- Two-factor sign-in with an authenticator app, with one-time recovery codes. Can be required for all staff.
- Automatic sign-out after 30 minutes idle (12-hour maximum session).
- Audit log viewer with filters and CSV export. The log is tamper-evident (hash chain).
- Security page with automatic alerts (repeated failed logins, unusual access, broken audit chain, failed backup) and an acknowledge-and-resolve workflow.
- Encrypted, automatically verified backups, with a Backups page for administrators.
- Clinic settings: name, logo, address, phone, NPI, tax ID and brand color, used across the app, printouts, superbills and emails.

## Phone and tablet

- Installs to the home screen on iPhone (Safari → Share → Add to Home Screen) and Android (Chrome → Install app).
- Opens full screen with its own icon and updates automatically.
- Nothing about patients is stored on the device; only an offline page is cached.

## Hosting

- Each clinic gets its own server, disk and database. One clinic can never see another clinic's data.
- Updates are rolled out by [Your Company LLC] and don't touch your data.

---

## Not available today

Be direct about these in every conversation.

- **Electronic claims submission / clearinghouse (837/835):** not built. Use printed superbills and the charge details in ChartReady with your billing service or clearinghouse.
- **Claims export file:** there is no claims export file today. Superbills can be printed or saved as PDF.
- **E-prescribing:** not built.
- **Patient portal:** none beyond phone check-in.
- **Lab interfaces, HIE connections, payer eligibility checks:** not built.
- **ONC certification:** ChartReady is not ONC-certified health IT.
- **SOC 2 report:** none.
- **Care-team access restrictions:** every clinician can open every chart; the audit log and access reports are the compensating control.
