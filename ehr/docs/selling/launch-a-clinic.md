# Launching a new customer clinic

Each clinic you sell to gets **its own copy** of the EHR: its own server, disk and database. One clinic can
never see another's data, and every copy updates automatically when you push new code to the branch.

## Before your first paying customer (one time)

1. **Business setup.** Form your company (e.g. an LLC). Have a healthcare attorney prepare your customer
   agreement (terms of service), privacy policy and **Business Associate Agreement (BAA)**. You sign a BAA with
   every clinic.
2. **HIPAA hosting.** Real patient data must live in a **HIPAA-enabled Render workspace** (higher plan tier,
   signed BAA with Render). Create that workspace and launch customer clinics there.
3. **Vendors.** If clinics use AI note review, you need a BAA with Anthropic. End-of-day emails contain no
   patient information, so any email service works.
4. **Licenses.** Get an AMA license for distributing CPT codes, check ASAM Criteria licensing for the ASAM
   assessment, and confirm commercial-use permission for screening tools (e.g. DAST-10).
5. **Insurance.** Cyber liability and technology errors & omissions (E&O).

## Launch a clinic (about 15 minutes)

1. In Render (your HIPAA workspace): **New → Blueprint**, pick this repository, and set
   **Blueprint path** to `deploy/new-clinic.render.yaml`.
   - For your second clinic and beyond, first edit that file's `name` (e.g. `ehr-desertbloom`) and disk name,
     or create the service by hand with the same settings.
2. Render asks for:
   - `EHR_CLINIC_NAME`: the clinic's name, e.g. `Desert Bloom Behavioral Health`
   - `EHR_ADMIN_EMAIL` / `EHR_ADMIN_PASSWORD`: the clinic owner's first login (they should change it)
   - `EHR_BACKUP_KEY`: generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and keep a copy in your
     password manager (backups can't be restored without it)
   - `EHR_OPS_TOKEN` is generated for you.
3. Deploy. When it's live, open `https://<service>.onrender.com/ehr`, sign in as the owner and go to
   **Administration → Clinic settings**: address, phone, group NPI, tax ID, logo and brand color.
4. Optional: a custom domain (e.g. `ehr.desertbloom.com`) under the service's **Settings → Custom Domains**.
5. Add the clinic to your customer list (next section).
6. Send the owner: their link, how to install the app on iPhone (Safari → Share → Add to Home Screen), and
   **Administration → Users** to add their staff.

## Your customer list

On **your own** EHR service, add the environment variable `EHR_FLEET` listing every customer clinic:

```json
[
  {"name": "Desert Bloom", "url": "https://ehr-desertbloom.onrender.com", "token": "<that clinic's EHR_OPS_TOKEN>"},
  {"name": "Sunrise Counseling", "url": "https://ehr-sunrise.onrender.com", "token": "<token>"}
]
```

Copy each clinic's `EHR_OPS_TOKEN` from its **Environment** page in Render. Then open
**Administration → Customers**: every clinic is checked live (up or down, staff and client counts, notes signed in
the last 30 days, last sign-in, whether data is saved to disk, backups, AI and email status, and code version).
It shows counts only, never patient information.

## Every clinic, every update

- Pushing to the deployment branch updates every clinic automatically (`autoDeploy: true`).
- Data lives on each clinic's disk, so updates never erase it. Check **Data saved = Yes** on the Customers page.
- Turn on encrypted backups (`EHR_BACKUP_KEY`) for every clinic and keep off-site copies (Render disk snapshots).
