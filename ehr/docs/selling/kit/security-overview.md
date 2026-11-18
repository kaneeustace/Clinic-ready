# ChartReady Security and HIPAA Overview

For a clinic's owner, privacy officer or security officer evaluating ChartReady. It answers the questions we're usually asked, describes what the software does today, and lists what is not yet in place.

ChartReady is provided by [Your Company LLC], which acts as your **business associate** under HIPAA. Software alone does not make a clinic HIPAA compliant; your policies, training and risk analysis still matter. We're glad to walk through any item below on a call.

---

## Summary

| Question | Short answer |
|---|---|
| Will you sign a BAA? | Yes. We sign a BAA with every clinic before any real patient data is entered. |
| Where is our data hosted? | On a HIPAA-enabled hosting workspace covered by a signed BAA between [Your Company LLC] and the hosting provider. [Hosting provider and region: confirm before sending.] |
| Is our data separate from other clinics? | Yes. Each clinic gets its own server, disk and database. |
| Is two-factor sign-in available? | Yes. Authenticator-app codes with recovery codes. It is required for all staff on hosted clinics by default. |
| Is there an audit log? | Yes. Views and changes of patient information, sign-ins and exports are logged. The log is tamper-evident. |
| Is data encrypted? | In transit, yes (HTTPS only). Backups are encrypted by the application. At rest, see "Encryption" below for exactly what is covered. |
| Can we get our data out? | Yes, per-client record exports at any time, and a full copy of your data on termination. |
| SOC 2 report? | No. Not available. |
| Third-party penetration test? | Not yet. Planned. |
| ONC certification? | No. |

---

## Hosting and the BAA chain

Every party that stores or processes your patient information must be under a BAA.

- **You and [Your Company LLC]:** we sign a Business Associate Agreement with your clinic.
- **[Your Company LLC] and the hosting provider:** your clinic runs only in a **HIPAA-enabled hosting workspace** covered by a signed BAA with the host. Demo and test systems run separately and never hold real patient information.
- **AI features (insurance compliance check and note scanner):** these send note text to Anthropic, the AI provider. They stay **off** for real patient data until a BAA with Anthropic covering this use is in place. Names, date of birth and record numbers are not sent as separate fields, but anything a clinician typed into the note text is included.
- **Text messages (Twilio):** check-in texts contain only the clinic name and a link. Texting is turned on for real clients only after a BAA with the texting provider is signed.
- **Email:** emails ChartReady sends (end-of-day note reminders, check-in links) contain **no patient information** by design: counts and a sign-in link, or the clinic name and a check-in link.
- **Other systems you use** (your billing service, clearinghouse, telehealth platform, fax) are your vendors. You need your own BAAs with them.

## Access control and roles

- Every person has their own account (unique email). Shared accounts should be prohibited by your policy.
- Four roles, each limited to what the job needs:

| Role | Can |
|---|---|
| Admin | Everything, plus users, audit log, security alerts, backups, clinic settings and fee schedule |
| Clinician | Charts, notes, treatment plans, measures, scheduling; view billing |
| Front desk | Patient demographics (not clinical notes), scheduling, intake requests; view billing |
| Billing | Patient demographics (not clinical notes), charges, payments, superbills |

- Attempts to open a page outside a role are refused and logged.
- **Psychotherapy notes** are visible only to the clinician who wrote them. Administrators can't see them either.
- Deactivating a user or resetting their password signs them out everywhere immediately.
- **Known limitation:** every clinician can open every client's chart. There are no care-team restrictions yet. Audit log review and per-client access reports are the compensating controls.

## Passwords and two-factor sign-in

- Passwords: at least 12 characters with 3 of 4 character types, stored using a strong one-way hash (scrypt).
- Lockout for 15 minutes after 5 failed attempts. Failed attempts and lockouts are logged and raise a security alert.
- **Two-factor sign-in** using an authenticator app on the user's phone, with one-time recovery codes. Hosted clinics are set up to require it for all staff; users are asked to enroll at their next sign-in.
- Administrators can reset a user's two-factor setup (for a lost phone) after re-entering their own password. This is logged.

## Sessions

- Automatic sign-out after **30 minutes** of inactivity, and a 12-hour maximum session.
- Session cookies are secure, HTTP-only and same-site; the server stores only a hash of the session token.
- Protection against cross-site request forgery on every change.
- EHR pages are marked "do not cache," so patient information is not kept in the browser cache.
- The installable phone app caches no patient information, only an offline page.

## Audit log

- Logged: views and changes of patient information, sign-ins and sign-outs, failed sign-ins, refused access attempts, note signing and failed signing, addenda, deletions, exports, password resets and account changes. Each entry has the time, user, action, record and IP address.
- **Tamper-evident:** each entry is linked to the previous one by a hash chain, so changing or deleting an old entry breaks the chain. Administrators can verify the chain from the Security page, and a broken chain raises an alert.
- Administrators can filter the log, export it to CSV (the export itself is logged), and print a per-client access report.
- **Security alerts** for repeated failed logins, unusually large access, after-hours access, a broken audit chain and failed backups, with an acknowledge-and-resolve workflow.

## Encryption

We describe exactly what is in place:

- **In transit:** all traffic uses HTTPS. In production, browsers are told to use HTTPS only (HSTS).
- **Backups:** application backups are encrypted with AES-256-GCM using a key held by [Your Company LLC], and each backup is verified after it is written.
- **Two-factor secrets:** encrypted by the application with a separate key, which we configure for every clinic. Recovery codes are stored only as hashes.
- **The main database file:** ChartReady does **not** add its own encryption layer to the live database file. Protection at rest relies on the hosting provider's disk encryption in the HIPAA-enabled workspace. [Confirm the host's at-rest encryption coverage in writing before sending this document.]

## Backups and recovery

- Data lives on a persistent disk, so restarts and software updates do not erase it.
- Encrypted, automatically verified backups on a schedule, with retention rules. A failed backup raises an alert.
- The hosting provider also takes daily disk snapshots.
- Backups can be restored by [Your Company LLC] from the command line to a separate location, so a live database is never overwritten.
- Restore testing schedule, off-site copy location and retention: [TBD; state the actual practice before sending].
- **Known limitation:** each clinic runs as a single server in a single region. There is no automatic failover. Your clinic should keep a short downtime procedure.

## Integrity of clinical records

- Signing a note requires re-entering the password. Signed notes can't be changed; corrections are dated addenda.
- Only the author can edit or delete a draft.
- Signed treatment plans are locked; revisions create a new version.

## Your data: access, export and ownership

- **You own your clinic's data.** [Your Company LLC] uses it only to provide the service, as set out in the BAA and Terms of Service.
- **Right of access:** staff can generate a copy of a client's designated record set (printable or as a data file). Psychotherapy notes are left out. Each export is logged.
- **Accounting of disclosures:** releases can be logged and an accounting printed for a client.
- **On termination:** we provide a complete copy of your data in [format: TBD] within [N] days of your request, then delete or return remaining copies as the BAA requires.
- **42 CFR Part 2:** release of information notes can be flagged as containing substance use disorder records, and the Part 2 redisclosure notice is shown. Whether and how Part 2 applies to your program is a question for your counsel.

## Incident response

- [Your Company LLC] maintains a written incident response procedure.
- If we discover a security incident or a breach of unsecured PHI affecting your clinic, we notify you within [N business days; to be set in the BAA], with what we know, and keep you updated. HIPAA allows business associates up to 60 days; our BAA commits to a shorter period.
- Security contact: [name, email, phone].

## Application security

- Strict content security policy and standard security headers.
- Cross-origin form posts are rejected.
- The public appointment request form is rate-limited and spam-filtered.
- An automated test suite runs against the code.

## Not yet in place

We'd rather you hear these from us.

- **No SOC 2 report.**
- **No third-party penetration test yet.** Planned before we scale beyond our first clinics.
- **No ONC certification.**
- **No care-team access restrictions** (see Access control).
- **No application-level encryption of the live database file** (relies on host disk encryption).
- **No automatic failover** to a second region.
- EHR pages currently load a web font from Google, which reveals the viewer's IP address to Google (no patient information is sent). Self-hosting fonts is planned.

## What your clinic is responsible for

- Your own HIPAA risk analysis, policies and workforce training.
- Managing user accounts: adding staff, assigning roles, deactivating people the day they leave.
- Reviewing the audit log and security alerts on a regular schedule.
- Securing the devices your staff use (screen locks, device encryption).
- BAAs with your other vendors (billing, telehealth, fax, email).
- Your notice of privacy practices, consent forms and Part 2 handling.

Questions: [security contact email].
