# ChartReady FHIR API (R4, read-only)

Base URL: `https://<your-clinic-host>/fhir` · Capability statement: `GET /fhir/metadata`

## Getting access

1. An administrator opens **Administration → API access (FHIR)** and creates an API client. They choose what it can read and whether it may receive 42 CFR Part 2 (substance use disorder) records.
2. The Client ID and secret are shown once. Share them securely, and only with a party covered by a BAA or another HIPAA-permitted purpose.
3. Revoking a client stops its tokens immediately.

## Getting a token (OAuth 2.0 client credentials)

```
POST /fhir/auth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)     # or client_id / client_secret form fields

grant_type=client_credentials&scope=system/*.read          # scope optional; defaults to the client's access
```

Response: `{"access_token": "...", "token_type": "Bearer", "expires_in": 3600, "scope": "system/*.read"}`.
Send it as `Authorization: Bearer <token>`. Ten failed attempts from one address lock token requests for 15 minutes.

## Resources

| Resource | Source | Search |
|---|---|---|
| Patient | Demographics, MRN (`urn:chartready:mrn`), AHCCCS ID (`urn:chartready:ahcccs-id`) | `_id`, `identifier`, `family`, `given`, `name`, `birthdate` |
| Practitioner | Clinicians (NPI) | `_id`, `identifier` |
| Organization | The clinic (`Organization/clinic`) | — |
| Appointment, Encounter | Schedule (Encounter = completed / checked-in visits) | `patient` |
| Condition | Problem list (ICD-10-CM) | `patient` |
| AllergyIntolerance | Allergies | `patient` |
| MedicationRequest | Prescriptions | `patient` |
| MedicationStatement | Medication list | `patient` |
| Observation | PHQ-9 (LOINC 44261-6), GAD-7 (70274-6) and other screening totals; hormone therapy labs (testosterone 2986-8, free T 2991-8, estradiol 2243-4, hematocrit 4544-3, hemoglobin 718-7, PSA 2857-1, LH, FSH) and vitals (BP 85354-9, heart rate 8867-4, weight 29463-7) | `patient`, `category` (survey, laboratory, vital-signs), `code` |
| Coverage | Insurance | `patient` |

`GET /fhir/Patient/{id}/$everything` returns everything above for one client. Searches return a `Bundle` (`_count` up to 200, `_offset`, `next` link).

## What is never shared

- Clinical notes and psychotherapy notes.
- Substance use disorder records (F10–F19 diagnoses, AUDIT and DAST-10, opioid/alcohol treatment medications), unless the client is allowed to receive Part 2 records.

Every token and request is in the audit log with the client ID and patient.

## Not included yet

Writing data, SMART on FHIR app launch (user sign-in), asymmetric (JWT) client authentication, bulk `$export`, and US Core certification. Ask if you need them.
