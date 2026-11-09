# Policy: Vendor Management and Business Associate Agreements

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Fill in the vendor inventory with the services the practice actually uses. Have counsel review each BAA. A vendor's marketing claim of "HIPAA compliant" is **not** a BAA. Complete the `[placeholders]` and adopt the policy.

| | |
|---|---|
| Policy owner | Privacy Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.308(b)(1), 164.314(a), 164.502(e), 164.504(e); 42 CFR 2.11 (qualified service organizations) |
| Source | HHS sample BAA provisions: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html |

## 1. Policy
1. **No vendor may create, receive, maintain, or transmit PHI for the practice until a signed BAA is in place.** That includes storing PHI, even encrypted, even when the vendor "never looks at it." HHS cloud guidance treats cloud providers that store encrypted ePHI as business associates: https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html.
2. **Before** signing up for any new service that will touch PHI, the Privacy Officer reviews:
   - the BAA;
   - the vendor's security posture: SOC 2 / HITRUST report if available, MFA support, encryption, data location, breach-notice timing;
   - how data is returned or destroyed at termination.
3. BAAs should require breach notice to the practice **within `[5–10]` business days** (shorter than HIPAA's 60-day maximum), subcontractor flow-down, and return or destruction of PHI at termination.
4. Track each BAA in the inventory below. Review the inventory **annually** and whenever a vendor is added or removed.
5. **Conduits** that only transmit data and don't store it beyond transient copies (for example, an internet service provider) don't need a BAA. Email and fax services that **store** messages are not conduits.
6. If the practice is a Part 2 program, vendors handling SUD records also need qualified service organization (QSO) terms. Under the 2024 rule, business associates are included in the QSO definition. Counsel should confirm the wording.

## 2. Vendor inventory

| Vendor / service | Purpose | PHI? | BAA needed? | BAA status / date / location | Notes and required settings |
|---|---|---|---|---|---|
| **Render** (render.com) | Hosts the EHR app, database (persistent disk), daily disk snapshots, logs | **Yes, all** | **Yes** | `[ ]` | Requires a **HIPAA-enabled workspace on a Scale or Enterprise plan**: Workspace Settings → Compliance → sign the BAA → Enable HIPAA. The upgrade is irreversible. Render adds 20% to usage. **Free instances aren't allowed**, so the `clinic-ready-demo` service in `render.yaml` must live in a separate non-HIPAA workspace or be removed. PHI must never appear in logs, build artifacts, `render.yaml`, or resource/environment-variable names. Source: https://render.com/docs/hipaa-compliance (checked 2026-11-09; re-check). Enforce MFA on all workspace members. Request the SOC 2 report. |
| *Alternative host* (AWS / Azure / GCP / Aptible / other) | Only if not using Render | Yes | Yes | `[ ]` | Use only HIPAA-eligible services under the provider's BAA. Use an encrypted volume at `/var/data`. |
| **CollaborateMD** | Practice billing, claims, clearinghouse, ERA | **Yes**: demographics, insurance, ICD-10, CPT, DOS | **Yes** | `[ ]` | Request the BAA from the account representative. Enforce MFA and unique user accounts. Transfer method from the EHR: `[superbill print/PDF keyed in / CSV upload]`. Delete any local export files after upload. Confirm it covers Part 2 data if applicable. |
| **Off-site backup storage** `[e.g. AWS S3 / Backblaze B2 / Wasabi]` | Copies of encrypted EHR backups | Yes (encrypted) | **Yes**, even though the data is encrypted | `[ ]` | Separate account from the hosting provider; Object Lock / immutability; MFA. |
| **Email** `[Google Workspace / Microsoft 365 / other]` | Staff email, patient communication | **Yes** | **Yes** | `[ ]` | Accept the BAA in the admin console (Google Workspace: Account → Legal & compliance; Microsoft: the BAA is part of the Product Terms / DPA; confirm your plan is eligible). Turn on MFA and TLS. Use `[encryption add-on / portal]` for PHI to outside recipients unless the patient has chosen unencrypted email. **No consumer Gmail, Yahoo, or Outlook.com.** |
| **Fax** `[eFax vendor / fax line]` | Records requests, ROI releases, referrals | **Yes** | **Yes** for cloud fax; a physical fax line over a phone carrier is generally a conduit | `[ ]` | Cover sheet with a confidentiality statement (and the Part 2 notice when applicable). Verify the number before sending. |
| **Telehealth platform** `[name]` | Video sessions | **Yes** | **Yes** | `[ ]` | Name the platform on `privacy.html`. No recording without consent. Waiting rooms on. |
| **Phone / VoIP / SMS / reminders** `[name]` | Calls, voicemail, texts, reminders | **Yes** | **Yes** if it stores voicemail, recordings, or texts | `[ ]` | Reminders show only the minimum (see the minimum-necessary policy). |
| **Password manager** `[name]` | Staff credentials; `EHR_DATA_KEY` / `EHR_BACKUP_KEY` | Keys only, which give access to PHI | Recommended (business plan); **required** if any PHI is stored in it | `[ ]` | Business tier with admin recovery and MFA. |
| **GitHub** | Source code, deploy trigger | **No (must stay that way)** | No, if no PHI | n/a | Never commit PHI, database files, backups, or keys. MFA on all accounts; branch protection. |
| **Domain registrar / DNS** `[name]` | Domain | No | No | n/a | Lock the domain; MFA. A domain hijack could redirect sign-ins. |
| **Shredding vendor** `[name]` | Paper disposal | Yes | Yes | `[ ]` | Certificate of destruction. |
| **IT consultant / developer** `[name]` | Support, development | Possibly (hosting access) | **Yes** if they can reach PHI and aren't workforce | `[ ]` | Least privilege; remove access when the engagement ends. |
| **Google Fonts** (fonts.googleapis.com, fonts.gstatic.com) | Web fonts on EHR and website pages | **No PHI in requests** (see §3) | Not obtainable; see §3 | n/a | **Recommendation: self-host fonts on EHR pages.** |
| **Website form handling** | Appointment requests | Yes | Handled by the EHR on Render, so the hosting BAA covers it | n/a | No third-party form vendor is used. Keep it that way, or get a BAA. |
| **Analytics / tracking** | None in the code today | — | — | — | **Don't add** tracking pixels or analytics to pages with health forms, or to any EHR page, without a privacy review. See HHS online tracking guidance: https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/hipaa-online-tracking/index.html (portions were vacated in *American Hospital Ass'n v. Becerra*, N.D. Tex. 2024; counsel to advise). |
| `[others]` | | | | | |

## 3. Google Fonts

**What happens:** every EHR page loads the stylesheet `https://fonts.googleapis.com/css2?family=Inter...` (`ehr/src/views.js`), and the browser then downloads font files from `fonts.gstatic.com`. The CSP in `ehr/src/app.js` explicitly allows both hosts. The public website pages, including `contact.html` with the appointment request form, load Google Fonts too.

**What Google receives:**
- the viewer's **IP address**, browser user agent, and time of the request;
- for the font-file request, the `Origin` header, which reveals the EHR's or website's domain.

Because the EHR sets `Referrer-Policy: same-origin`, Google does **not** receive the page path, so it never sees patient IDs or chart URLs. The font URL itself is static and contains no PHI.

**Does it matter?**
- **EHR pages:** the people loading them are **workforce members**, not patients, and no patient information goes to Google. This is very likely **not a disclosure of PHI**. It is still an unnecessary third-party dependency on pages that display PHI:
  - Google learns when and from where staff use the EHR.
  - The CSP has to allow external style and font origins, which weakens it a little.
  - The EHR's appearance depends on a vendor that has no BAA.
- **Public website / contact page:** visitors may be prospective patients. An IP address paired with a visit to a behavioral health provider's site *could* be argued to be health-related information. HHS's 2022/2024 tracking guidance took a broad view of this. The part about unauthenticated pages was vacated by a federal court in 2024, and font loading isn't tracking or analytics. The risk is **low**, but cheap to remove.

**Recommendation (owner action; developer task):**
1. **Self-host the Inter font** for EHR pages: put the `.woff2` files under `ehr/public/` (served at `/ehr/static/`), remove the three `<link>` tags in `views.js`, and remove `https://fonts.googleapis.com` and `https://fonts.gstatic.com` from the CSP in `app.js`. Inter and Fraunces are open-source (SIL Open Font License), so self-hosting is permitted.
2. Do the same on the public website, at minimum on `contact.html`, `new-patients.html`, and `crisis.html`.
3. Until then, record this as **R16 (Low)** in the risk register.

## 4. Vendor offboarding
When a vendor relationship ends:
1. Get written confirmation that PHI has been returned or destroyed. If it can't be, the BAA's protections continue.
2. Remove the vendor's access and integrations.
3. Update the inventory.

## 5. Adoption
Adopted by: ____________________ Date: ________. Keep BAAs and this policy for 6 years after expiry.
