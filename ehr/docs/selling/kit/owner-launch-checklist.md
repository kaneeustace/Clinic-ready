# Owner Launch Checklist: Before Taking Money

For Kane, as owner of [Your Company LLC]. These are the business, legal and vendor steps outside the code. Work top to bottom; the first section can block everything else.

Legend: **Blocker** = do before signing any customer or accepting payment. **Before PHI** = do before any clinic enters real patient information. **Soon** = within the first few customers.

---

## A. Settle who owns the software (Blocker)

- [ ] Get a written agreement with **Blue Bell Behavioral Health** confirming that you (or your new LLC) own ChartReady and may sell it. Have an attorney draft or review it.
- [ ] List what to cover: who owns the code, the clinic website, docs and any name or branding; whether Blue Bell keeps a license to use it (and on what terms); any confidential Blue Bell information that must be removed.
- [ ] Remove any Blue Bell data, names or internal documents from the product and repository.

Why it matters: you are COO of Blue Bell, and the software may have been built on company time, with company resources or for company use. Without a clear written assignment, Blue Bell could claim ownership, which could stop sales, scare off customers and void the warranties you give in your contracts. Buyers and investors will ask.

## B. Form the business (Blocker)

- [ ] Form an LLC (Arizona or your chosen state). Replace "[Your Company LLC]" everywhere with the legal name.
- [ ] Get an EIN from the IRS.
- [ ] Open a business bank account. Keep all ChartReady money separate from personal and Blue Bell funds.
- [ ] Assign the software from you personally to the LLC in writing (after step A).

Why it matters: limits personal liability and gives customers a real entity to contract with.

## C. Contracts with a healthcare attorney (Blocker)

- [ ] Engage a healthcare / technology attorney licensed in Arizona.
- [ ] Finalize the **Terms of Service**, **Business Associate Agreement**, **Order Form** and **Privacy Policy** (starting drafts are in `agreements/`).
- [ ] Ask specifically about 42 CFR Part 2 (substance use disorder records), limitation of liability, breach notification timing, and Arizona governing law.

Why it matters: the drafts are a starting point only. A clinic's compliance person will read the BAA closely.

## D. Insurance (Blocker)

- [ ] **Cyber liability** insurance (breach response, notification costs, regulatory defense).
- [ ] **Technology errors and omissions (E&O)** insurance.
- [ ] Ask the broker whether the policy covers a business associate handling behavioral health records.

Why it matters: a single breach or software error could exceed a small company's resources. Some clinics will ask for a certificate of insurance.

## E. HIPAA hosting (Before PHI)

- [ ] Create a **HIPAA-enabled Render workspace** and sign Render's BAA. This requires a higher Render plan tier; budget for it.
- [ ] Launch every customer clinic inside that workspace. Keep the public demo outside it.
- [ ] Create the public demo: in Render, New → Web Service from this repo (root directory `ehr`, free plan, environment `EHR_DEMO=1`, `EHR_TZ=America/Phoenix`). It reloads fictional sample data on every restart. Then set `EHR_DEMO_URL` on your main service to its `/ehr/login` address so the sales page shows "Try the live demo".
- [ ] Confirm every clinic has a **persistent disk** attached (Administration → Customers should show Data saved = Yes).
- [ ] Set `EHR_BACKUP_KEY` and `EHR_DATA_KEY` for every clinic; store copies in a password manager plus a sealed escrow copy. Note: `deploy/new-clinic.render.yaml` asks for the backup key but does not include `EHR_DATA_KEY`; add it by hand, or two-factor secrets are stored unencrypted (the security overview promises they are encrypted).
- [ ] Turn on MFA for every Render and GitHub account with access.
- [ ] Get written confirmation of the host's encryption at rest coverage for disks and snapshots.

Why it matters: real patient data on non-HIPAA hosting, or without a BAA, is a violation on day one. Without the persistent disk, a restart erases the clinic's data.

## F. Other vendor BAAs (Before PHI)

- [ ] **Anthropic BAA** before the AI insurance compliance check or note scanner touches real patient data. Keep AI review off until then.
- [ ] **Twilio BAA** before texting check-in links to real clients.
- [ ] Email: ChartReady's emails contain no patient information by design, so a BAA isn't strictly required for them. Keep it that way; re-check if email content ever changes.
- [ ] Keep a vendor list with BAA status and dates.

Why it matters: every subcontractor that touches PHI must be under a BAA, and your customer BAA promises this.

## G. Content licenses (Before selling)

- [ ] **AMA CPT license** for distributing CPT codes and descriptors in the fee schedule and superbills.
- [ ] **ASAM Criteria** licensing for ASAM-branded content in the ASAM assessment.
- [ ] Confirm commercial-use permission for each screening instrument (for example **DAST-10**; also review AUDIT, C-SSRS, PCL-5, MDQ, ASRS, PHQ-9, GAD-7).

Why it matters: these are copyrighted. Using them in a product you sell without permission invites a demand letter.

## H. Make the GitHub repository private (Blocker)

- [ ] Set the repository to private.
- [ ] Review who has access; require MFA on GitHub.
- [ ] Protect the deploy branch, since every push deploys to every clinic automatically.

Why it matters: the code is the product. A public repo also exposes your setup details.

## I. Security (Before PHI / Soon)

- [ ] Commission a **third-party penetration test** before scaling beyond the design partners. Fix findings and keep the summary letter for buyers.
- [ ] Write down incident response contacts: you, a backup person, your attorney, your cyber insurer's hotline, Render support.
- [ ] Decide your breach-notice commitment to customers (the BAA draft leaves it as [N] business days).
- [ ] Complete your own (business associate) security risk assessment and policies.
- [ ] Run and record a backup restore test.

Why it matters: buyers will ask for evidence. The security overview says a pen test is "planned"; keep that true.

## J. Support plan (Before selling)

- [ ] Support hours (for example weekdays [time] to [time] Arizona time).
- [ ] Channel: [support email], [phone], and how urgent issues reach you after hours.
- [ ] Response-time targets by severity (for example "system down" vs "how do I").
- [ ] Who covers when you're unavailable.
- [ ] Put these in the Terms of Service and onboarding guide.

Why it matters: clinics can't see clients without their EHR. Clear expectations avoid disputes.

## K. Payments (Before selling)

- [ ] Choose invoicing (monthly invoice, ACH) or Stripe subscriptions.
- [ ] Set payment terms (due date, late payment, suspension rules) and match the Terms of Service.
- [ ] Decide the onboarding fee amount (currently [TBD]).
- [ ] Set up bookkeeping and sales-tax review with an accountant (SaaS taxability varies by state).

## L. Design partners and referral partners (Soon)

- [ ] Recruit the first 3 Arizona clinics for the design-partner offer: 60 days free in exchange for structured feedback and a testimonial. Put the terms in the Order Form.
- [ ] Get written permission before using any clinic's name or testimonial.
- [ ] Recruit referral partners such as behavioral health billing consultants. Plan: **20% recurring commission**. Put it in a written referral agreement (attorney review), and check that commissions are structured appropriately for healthcare referral rules.

Why it matters: early references are what sell the next clinics.

---

## Quick status

| Area | Status | Date |
|---|---|---|
| A. IP agreement with Blue Bell | | |
| B. LLC, EIN, bank | | |
| C. Attorney-reviewed agreements | | |
| D. Cyber + E&O insurance | | |
| E. HIPAA hosting + BAA | | |
| F. Anthropic / Twilio BAAs | | |
| G. CPT, ASAM, instrument licenses | | |
| H. Private repo | | |
| I. Pen test, incident contacts | | |
| J. Support plan | | |
| K. Payments | | |
| L. Design / referral partners | | |
