# ChartReady FHIR API

FHIR R4 (4.0.1), read-only, JSON. Built to **US Core 6.1**, **SMART App Launch 2.x** (v1 and v2 scopes) and **Bulk Data Access 2.0**, the standards behind ONC's standardized API criterion, § 170.315(g)(10).

| | |
|---|---|
| Base URL | `https://<clinic-host>/fhir` |
| Capability statement | `GET /fhir/metadata` |
| SMART configuration | `GET /fhir/.well-known/smart-configuration` |
| OpenID configuration / keys | `/fhir/.well-known/openid-configuration`, `/fhir/.well-known/jwks.json` |
| Authorize (SMART apps) | `https://<clinic-host>/ehr/smart/authorize` |
| Token | `POST /fhir/auth/token` |

## Registering

An administrator registers every app or system under **Administration → API access (FHIR)**:

- **Backend service.** A system with no user, such as an HIE, a data warehouse, a lab or a payer. It uses `system/` scopes and bulk export. It authenticates with a client secret, or with a signed JWT if you paste its public JWK Set.
- **SMART app.** An app a staff member signs in to (standalone launch). It needs redirect URIs (https only, except `http://localhost`). It can be:
  - *public*: PKCE only, no secret; or
  - *confidential*: a secret or a JWK Set.

Choosing whether a client may receive 42 CFR Part 2 records is part of registration.

## Signing in

### Backend services (`client_credentials`)

```
POST /fhir/auth/token
grant_type=client_credentials&scope=system/*.read
```

Authenticate with either:

- `Authorization: Basic base64(client_id:client_secret)`, or the `client_id` / `client_secret` form fields; or
- **private_key_jwt**: `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer&client_assertion=<JWT>`. The JWT:
  - is signed RS384 or ES384 with a registered key;
  - has `iss` = `sub` = client_id and `aud` = the token URL;
  - has `exp` at most 5 minutes ahead and a unique `jti`. A reused `jti` is refused.

### SMART apps (authorization code + PKCE)

1. Send the user to `/ehr/smart/authorize` with:
   - `response_type=code`, `client_id`, `redirect_uri`, `state`
   - `scope`, for example `launch/patient openid fhirUser patient/*.read`
   - `aud=<base URL>`
   - `code_challenge` and `code_challenge_method=S256`
2. The staff member signs in to ChartReady if needed, picks the client (for `launch/patient`), and approves.
3. Exchange the code at the token endpoint: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. Confidential apps also authenticate.

The token response includes `patient` (with `launch/patient`) and a signed RS256 `id_token` with a `fhirUser` claim (with `openid fhirUser`).

### Scopes and tokens

- Tokens last one hour. There are no refresh tokens.
- `patient/` scopes limit every read and search to the chosen client.
- `user/` scopes follow the staff member's own role.
- Both `.read` (v1) and `.rs` (v2) forms are accepted.

## Resources

| Resource | US Core profile | Source | Search |
|---|---|---|---|
| Patient | us-core-patient (race, ethnicity, birth sex, preferred language) | Demographics, MRN, AHCCCS ID | `_id`, `identifier`, `name`, `family`, `given`, `birthdate`, `gender` |
| Practitioner | us-core-practitioner | Staff (NPI) | `_id`, `identifier`, `name` |
| Organization | us-core-organization | The clinic (`Organization/clinic`) | `_id` |
| Encounter | us-core-encounter | Completed / checked-in visits | `patient`, `_id`, `date`, `status` |
| Appointment | (base) | Schedule | `patient` |
| Condition | us-core-condition-problems-health-concerns | Problem list (ICD-10-CM) | `patient`, `category`, `clinical-status`, `code` |
| AllergyIntolerance | us-core-allergyintolerance | Allergies | `patient`, `clinical-status` |
| MedicationRequest | us-core-medicationrequest | Prescriptions (`intent=order`) and medication list (`intent=plan`, reported) | `patient`, `intent`, `status`, `authoredon` |
| MedicationStatement | (base) | Medication list | `patient` |
| Observation | us-core-observation-lab, -blood-pressure, -heart-rate, -body-weight, -observation-screening-assessment | Labs, vitals, PHQ-9/GAD-7 and other screening totals (LOINC) | `patient`, `category`, `code`, `date`, `status` |
| Coverage | us-core-coverage | Insurance | `patient` |
| DocumentReference | us-core-documentreference (clinical-note) | Signed notes as plain text (LOINC note types) | `patient`, `category`, `type`, `date`, `status` |
| CarePlan | us-core-careplan (assess-plan) | Treatment plans | `patient`, `category`, `status` |
| Goal | us-core-goal | Treatment plan goals | `patient`, `lifecycle-status` |
| CareTeam | (base) | Primary clinician and active prescribers | `patient` |
| Group | (base) | `Group/all`, every client (for bulk export) | `_id` |

Searches return a `Bundle` (`_count` up to 200, `_offset`, `next` link). Date searches take `eq`/`ge`/`le`/`gt`/`lt` prefixes and can be repeated. Unknown parameters are refused with 400.

`GET /fhir/Patient/{id}/$everything` returns one client's record.

## Bulk export

Backend services with `system/` scopes can export in bulk.

1. **Start an export.** Send `Prefer: respond-async` to one of:
   - `GET /fhir/$export`
   - `GET /fhir/Patient/$export`
   - `GET /fhir/Group/all/$export`

   Optional parameters: `_type` (comma-separated resource types) and `_since` (an instant). The response is `202 Accepted` with a `Content-Location` header pointing to the status URL.
2. **Check progress** with `GET /fhir/bulkstatus/{id}`. It returns 202 while running, then a manifest of NDJSON file URLs. Downloading the files needs the same access token.
3. **Delete** the job with `DELETE /fhir/bulkstatus/{id}`. Output is otherwise kept for 24 hours.

## What is never shared

- Psychotherapy notes, drafts and release-of-information forms.
- Substance use disorder records (42 CFR Part 2), unless the client is registered to receive them. That covers:
  - F10–F19 diagnoses;
  - AUDIT and DAST-10 scores;
  - opioid and alcohol treatment medications;
  - ASAM notes and SUD treatment plans;
  - notes for clients with an active SUD diagnosis.

Every token, authorization and request is in the audit log, with the client ID and patient.

## Before certification

The API follows the standards ONC tests. Formal certification additionally requires:

- passing the ONC **Inferno** (g)(10) test kit against a hosted copy;
- an ONC-Authorized Certification Body;
- published API documentation and terms;
- the rest of the certification criteria.

Patient-facing access (patients signing in themselves) would also need a patient portal account system, which ChartReady doesn't have yet.

Not included: writing data, EHR launch (`launch` parameter), refresh tokens, `_include`/`_revinclude`, and Provenance.
