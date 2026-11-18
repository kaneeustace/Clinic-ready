# ChartReady 20-Minute Demo Script

A live walkthrough using the public demo. Aim to show a clinic's real day, not every screen. Stop and ask questions often.

---

## Before the call (10 minutes)

- **Demo link:** your demo service's address, e.g. `https://clinic-ready-demo.onrender.com/ehr` (a separate free Render service with `EHR_DEMO=1`; see the owner launch checklist). Never demo on a customer clinic's copy.
- Open it a few minutes early. The demo runs on a free instance that may take a moment to wake up, and it **resets to fresh sample data whenever it restarts**, so changes you make during a call may disappear later.
- **Never enter real patient information in the demo.** Say so out loud if the prospect is driving.
- Open two browser windows (one normal, one private) so you can switch roles without signing out.
- For the AHCCCS section use **Jordan Rivera**: the demo gives this fictional client the AHCCCS ID A12345678.
- Have your phone ready to show phone check-in.

**Demo logins** (password for all: `Demo-Password-2026!`)

| Role | Email |
|---|---|
| Therapist (clinician) | therapist@example.com |
| Counselor (clinician) | counselor@example.com |
| Prescriber (clinician) | prescriber@example.com |
| Front desk | frontdesk@example.com |
| Billing | billing@example.com |
| Admin | admin@example.com |

**Discovery questions to ask in the first 2 minutes**
- How many clinicians, and how many are associate-level or BHTs who need co-signs?
- What share of your clients are AHCCCS? Which health plans?
- Do you run IOP or other levels of care?
- Who does your billing today, in-house or a billing service?
- What happened in your last audit or records request?

---

## 1. Dashboard workboard (2 minutes)

Sign in as **therapist@example.com**.

Show:
- The workboard: **To do** (sessions with no note yet), **In progress** (drafts, notes waiting on a co-sign), **Done**.
- The live countdown on each item, and how it turns red when overdue.
- Today's schedule, check-ins, safety flags and utilization reviews due.

Talking points:
- "This is the first thing a clinician sees. They never have to hunt for what's unsigned."
- "Every clinician also gets an end-of-day email with their counts and a sign-in link. No patient information is in the email."

## 2. Patient chart (2 minutes)

Open a sample client from **Patients**.

Show:
- The banner: photo, current level of care, any safety flag.
- The tabs: Overview, Appointments, Notes, Treatment plan, Measures, Billing, Level of care, Pictures.
- Overview: demographics, insurance, problem list (ICD-10), allergies, medications.
- Measures: PHQ-9/GAD-7 trend chart.

Talking point: "Everything an auditor asks for is in one place, and every view of this chart is logged."

## 3. Treatment plan (2 minutes)

Open the **Treatment plan** tab.

Show:
- Problems, goals, measurable objectives and interventions.
- Signatures: clinician, client, guardian, supervisor. Signing locks the plan.
- The count of notes that addressed each objective (the golden thread).

Talking points:
- "Progress and group notes can't be written without a signed, active plan. That closes one of the most common audit findings."
- "Intake, crisis and ASAM notes are never blocked, so you can always document an assessment or a crisis."

## 4. Progress note and insurance compliance check (4 minutes)

From the **Notes** tab, open or start a progress note.

Show:
- DAP or SOAP format, structured mental status and risk sections.
- Picking the plan objectives this session addressed.
- **Check insurance compliance** on the note. Walk through the findings.
- Signing with a password re-entry; after signing, the note is locked and corrections go in an addendum.
- **Note scanner** (left menu): upload a PDF note from another system, pick the payer, see findings.

Talking points:
- "This is a second set of eyes before you bill, not after the auditor finds it."
- "The AI review is advisory and off by default. For real patient data we turn it on only after a BAA with the AI provider is signed."
- If the AI isn't turned on in the demo: the rule-based checks still run; describe the AI findings instead of improvising them.

## 5. AHCCCS fields (2 minutes)

Open a note for the client with an AHCCCS ID.

Show:
- Fields that appear only for AHCCCS members: actual start/stop times, service type, place of service and member location, telehealth modality (GT/FQ), participants, interpreter.
- The late-entry reason for notes signed more than 48 hours after the session.
- The cloned-note warning (describe it if you can't trigger it quickly).

Talking point: "Your commercial clients get a normal note. AHCCCS rules switch on only when an AHCCCS ID is on file."

## 6. Level of care and census (2 minutes)

Open the client's **Level of care** tab, then the **Census** page.

Show:
- Current level with ASAM level and program; step-up/step-down history with reasons.
- Payer authorizations: days or sessions used, next review, expiry.
- Census: who is at each level on a date, admissions and discharges, reviews due.

Talking point: "No more UR spreadsheet. Reviews due in the next 3 days show on the dashboard."

## 7. Phone check-in and kiosk (2 minutes)

Switch to **frontdesk@example.com**. Open **Schedule → Check-ins**.

Show:
- Today's check-ins and a group roster card ("3 of 5 here").
- Sending a check-in link from an appointment page. Mention links also go out automatically before each appointment by email or text.
- On your phone, the client side: confirm contact info, insurance card photos, PHQ-9/GAD-7 when due, consent signature.
- **Set up a kiosk** for a front-desk iPad. It resets between clients.

Talking points:
- "Contact changes are held for staff review. Nothing overwrites the chart without a person looking."
- "If a client answers the self-harm question positively, they see crisis resources and your staff are alerted."
- "Texts and emails contain only your clinic name and a link."

## 8. Billing and superbill (2 minutes)

Switch to **billing@example.com**. Open **Billing**.

Show:
- The work queue of completed visits not yet charged.
- Creating a charge; AHCCCS checks on units, modifiers and place of service.
- Claim status, payments, the client ledger.
- A printable superbill with the clinic's name, logo, NPI and tax ID.

Talking point: "ChartReady doesn't submit claims. It makes sure the documentation behind the claim holds up, then hands clean charge details to whoever submits."

## 9. Admin and security (2 minutes)

Switch to **admin@example.com**.

Show:
- **Administration → Users:** roles, supervisor assignment, "notes need co-signature," two-factor status.
- **Audit log** with filters and CSV export; the per-client access report.
- **Security** page: alerts and audit-chain verification.
- **Backups** page.
- **Administration → Clinic settings:** name, logo, NPI, tax ID, brand color.

Talking point: "Your compliance person can answer 'who looked at this chart' in under a minute."

## Close (1 minute)

- Recap the two or three things they reacted to most.
- Pricing: Clinic plan $399/month (up to 20 clinicians); Solo $149; Group $799. Launch pricing.
- If they're in Arizona and a fit: the design-partner offer (60 days free for the first 3 Arizona clinics, in exchange for feedback and a testimonial).
- Next step: send the security overview and draft agreements; schedule a follow-up with their compliance or billing lead.

---

## Common objections and honest answers

**"Does it submit claims?"**
Not yet. There's no clearinghouse connection. You print superbills and send the charge details to your billing service or enter them in your clearinghouse. What ChartReady adds is the checking before the claim: signed note, matching units, modifiers, current plan.

**"Can it export claims data to our billing company?"**
Superbills print or save as PDF. There isn't a claims export file today. If your biller needs a specific format, tell us; that's useful input.

**"Do you do e-prescribing?"**
No. Your prescribers keep using their current e-prescribing tool. Medications can be recorded on the chart.

**"Is there a patient portal?"**
Only phone check-in: clients update contact details and insurance, complete screeners and sign consent. No messaging, records or payments portal.

**"Are you ONC-certified?"**
No. If you participate in a program that requires certified EHR technology, ChartReady won't meet that requirement.

**"Do you have a SOC 2 report or a pen test?"**
No SOC 2. A third-party penetration test is planned and hasn't been done yet. We'll share the security overview, which lists what is and isn't in place.

**"Is the AI reading our patients' notes?"**
Only when you click the compliance check or use the note scanner, and only after a BAA with the AI provider is in place. It's advisory; it never changes a note.

**"You're a small company. What if you go away?"**
Your data is yours. You can export client records at any time, and the agreement commits us to hand over a full copy of your data on termination.

**"How long does setup take?"**
We can stand up your clinic's system quickly; the real work is your side: clinic settings, staff accounts, two-factor sign-in and loading clients. See the onboarding guide.

**"Can we move our old records in?"**
Ask what they have. Don't promise an import. Any data-setup help falls under the optional onboarding fee, scoped case by case.

**"Will it work for our IOP?"**
Show level of care, authorizations, UR dates and group check-in rosters. Group notes are supported.

**"Can clinicians see every chart?"**
Yes, today every clinician can open every chart. Every view is logged, and administrators can run an access report per client.
