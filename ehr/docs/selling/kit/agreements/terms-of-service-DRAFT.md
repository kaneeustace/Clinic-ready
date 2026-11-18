# ChartReady Terms of Service (DRAFT)

> **DRAFT FOR ATTORNEY REVIEW. Not legal advice. Do not sign or publish until a licensed attorney has reviewed and adapted it.**
>
> Bracketed items are placeholders or open questions for counsel. Notes to counsel are in italics.

**Effective date:** [date]
**Provider:** [Your Company LLC], a [state] limited liability company ("**we**," "**us**," "**Provider**")
**Customer:** the clinic or organization named on the Order Form ("**you**," "**Customer**")

These Terms of Service ("**Terms**"), the Order Form, and the Business Associate Agreement ("**BAA**") together form the agreement between Provider and Customer (the "**Agreement**"). If they conflict, the order of priority is: (1) the BAA, as to Protected Health Information; (2) the Order Form; (3) these Terms.

---

## 1. Definitions

- **Service:** the ChartReady hosted electronic health record software and related support provided by Provider.
- **Customer Data:** all information, including Protected Health Information, that Customer or its Authorized Users enter into or upload to the Service.
- **Authorized User:** an employee or contractor of Customer whom Customer permits to use the Service under its account.
- **Order Form:** the signed order describing the plan, number of clinicians, term and fees.
- **Protected Health Information (PHI):** as defined in 45 CFR 160.103.

## 2. The subscription

2.1 **Access.** During the subscription term, Provider grants Customer a non-exclusive, non-transferable right for its Authorized Users to use the Service for Customer's internal business purposes, within the limits on the Order Form (for example locations and clinicians).

2.2 **Separate instance.** Provider hosts Customer's Service on a separate application instance and database not shared with other customers.

2.3 **Accounts.** Customer is responsible for its Authorized Users: creating and removing accounts, assigning appropriate roles, keeping credentials confidential, and requiring two-factor sign-in where Provider makes it available. Each account is for one individual.

2.4 **Updates.** Provider may update the Service from time to time. Provider will not materially reduce the core functionality of the Service during a paid term without [notice / Customer's consent]. *[Counsel: confirm.]*

2.5 **Features not included.** Unless an Order Form states otherwise, the Service does not include electronic claims submission, clearinghouse connections, e-prescribing, or a patient portal beyond client check-in. The Service is not certified under the ONC Health IT Certification Program.

2.6 **AI-assisted features.** Certain optional features send note content to a third-party AI provider to generate advisory documentation findings. Provider will enable these features for PHI only after a business associate agreement with that provider is in place. Findings are advisory; Customer and its clinicians remain responsible for all clinical documentation, coding and billing decisions.

## 3. Fees and payment

3.1 **Fees.** Customer pays the fees on the Order Form. Launch pricing: Solo $149/month; Clinic $399/month; Group $799/month, as described on the Order Form. An optional one-time onboarding and data-setup fee may apply: [TBD].

3.2 **Billing and payment.** Fees are billed [monthly in advance] by [invoice / card or ACH through a payment processor]. Payment is due within [N] days of invoice.

3.3 **Late payment.** Overdue amounts may accrue interest at [rate, not to exceed the legal maximum]. If payment is more than [N] days overdue, Provider may suspend access after [N] days' written notice. Suspension does not delete Customer Data. *[Counsel: consider a clinical-continuity carve-out, e.g. read-only access during suspension.]*

3.4 **Taxes.** Fees exclude taxes. Customer pays applicable sales, use or similar taxes, other than taxes on Provider's income.

3.5 **Price changes.** Provider may change fees for renewal terms with at least [60] days' written notice.

3.6 **Design-partner terms.** If the Order Form designates Customer as a design partner, the free period and feedback/testimonial terms on the Order Form apply. Provider will not publish Customer's name or testimonial without Customer's written approval of the specific content.

## 4. Customer Data

4.1 **Ownership.** As between the parties, Customer owns all Customer Data. Provider acquires no ownership rights in Customer Data.

4.2 **Provider's use.** Provider may use Customer Data only to provide, maintain, secure and support the Service for Customer, as permitted by the BAA, and as required by law. Provider will not sell Customer Data or use PHI for marketing.

4.3 **Aggregate operational data.** Provider may collect non-identifying operational metrics about the Service (for example counts of users, notes signed, uptime and version), which contain no PHI, to operate and improve the Service. *[Counsel: confirm scope; the Service's fleet status page reports counts only.]*

4.4 **Export during the term.** Customer may export individual client records from the Service at any time using its built-in record export tools. On request, Provider will provide a full copy of Customer Data in [format] within [N] days.

4.5 **Export and deletion on termination.** For [30] days after termination or expiration ("**Transition Period**"), Provider will, on Customer's written request, provide a complete copy of Customer Data in [format, e.g. the database file and/or a structured export]. After the Transition Period, Provider will delete or return Customer Data, including backups, within [N] days, consistent with the BAA, except where retention is required by law or return/destruction is infeasible (in which case the BAA's protections continue).

4.6 **Records retention.** Customer is responsible for meeting its own medical-record retention obligations (for example under Arizona law and payer contracts), including by exporting Customer Data before the end of the Transition Period.

## 5. Security and privacy

5.1 **Safeguards.** Provider maintains administrative, physical and technical safeguards for Customer Data as described in the BAA and Provider's then-current security overview.

5.2 **BAA.** The parties will sign the BAA before Customer enters PHI into the Service. Customer must not enter PHI until the BAA is signed.

5.3 **Customer responsibilities.** Customer is responsible for its own HIPAA compliance, including risk analysis, policies, workforce training, device security, patient notices and consents, and business associate agreements with its other vendors.

## 6. Acceptable use

Customer and its Authorized Users will not:
- use the Service in violation of law, including HIPAA, 42 CFR Part 2 and state privacy law;
- share accounts or credentials, or let anyone other than Authorized Users use the Service;
- attempt to gain unauthorized access to the Service, other customers' data, or Provider systems;
- probe, scan or test the Service's vulnerabilities without Provider's written permission;
- upload malware or interfere with the Service's operation;
- reverse engineer, copy, resell or create derivative works of the Service, except as permitted by law;
- use the Service's demo environment for real patient information.

Provider may suspend access that threatens the security or integrity of the Service, with notice as soon as practicable.

## 7. Service availability

7.1 **Availability.** Provider will use commercially reasonable efforts to keep the Service available, excluding scheduled maintenance and events outside Provider's reasonable control. Target availability: [TBD]. *[Counsel/owner: no uptime commitment has been set. Do not insert a percentage until it can be measured and met; the current architecture is a single instance in a single region without automatic failover.]*

7.2 **Maintenance.** Provider will try to schedule maintenance outside Customer's normal business hours and give notice of planned downtime where practicable.

7.3 **Backups.** Provider maintains encrypted backups of Customer Data as described in the security overview.

7.4 **Downtime procedures.** Customer should maintain its own downtime procedures for clinical operations.

## 8. Support

Provider provides support by [email / phone] during [hours, time zone], with target response times of [TBD by severity]. Plans that include priority support receive [TBD]. Onboarding assistance is described on the Order Form.

## 9. Term and termination

9.1 **Term.** The initial term and renewal terms are stated on the Order Form. Unless stated otherwise, the subscription renews automatically for successive [monthly] terms unless either party gives [30] days' notice of non-renewal.

9.2 **Termination for cause.** Either party may terminate the Agreement if the other materially breaches it and fails to cure within [30] days after written notice. Customer may terminate as provided in the BAA.

9.3 **Effect.** On termination, access ends (subject to the Transition Period in Section 4.5), and Customer pays any fees owed through the termination date. *[Counsel: refunds of prepaid fees on termination for Provider's breach.]*

9.4 **Survival.** Sections 4, 5, 10, 11, 12 and 13, and any other terms that by their nature should survive, survive termination.

## 10. Intellectual property

The Service, including its software, design and documentation, is owned by Provider and its licensors. No rights are granted except as stated in these Terms. Customer's feedback may be used by Provider without obligation, but Provider will not identify Customer as its source without permission. Third-party content in the Service (for example code sets and assessment instruments) is subject to its owners' terms. *[Counsel: confirm Provider's chain of title to the software before signing customers; see owner launch checklist item A.]*

## 11. Warranties and disclaimers

11.1 **Mutual.** Each party warrants it has authority to enter into the Agreement.

11.2 **Provider.** Provider warrants that the Service will perform materially as described in its documentation during the term. Customer's remedy for breach of this warranty is for Provider to use reasonable efforts to correct the non-conformity or, failing that, for either party to terminate and Customer to receive a refund of prepaid fees for the remaining term.

11.3 **Disclaimer.** EXCEPT AS EXPRESSLY STATED, THE SERVICE IS PROVIDED "AS IS" AND PROVIDER DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. PROVIDER DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED OR ERROR-FREE.

11.4 **Not clinical, legal or billing advice.** The Service, including its documentation checks, payer-rule checks and AI-assisted findings, is a tool. It does not provide medical, legal, coding or billing advice, does not guarantee payment of any claim or the outcome of any audit, and does not replace professional judgment. Payer rules change; Customer is responsible for confirming current requirements.

## 12. Limitation of liability

12.1 **Exclusion.** NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS OR REVENUE, EVEN IF ADVISED OF THEIR POSSIBILITY.

12.2 **Cap.** EACH PARTY'S TOTAL LIABILITY ARISING OUT OF THE AGREEMENT IS LIMITED TO [THE FEES PAID OR PAYABLE BY CUSTOMER IN THE [12] MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM].

12.3 **Exceptions.** [Counsel: decide whether the cap and exclusion apply to (a) breach of the BAA or confidentiality, (b) indemnification obligations, (c) Customer's payment obligations, (d) gross negligence or willful misconduct; consider a separate, higher cap for data breaches, aligned with Provider's cyber insurance limits.]

## 13. Indemnification

[Counsel: consider (a) Provider indemnifying Customer for third-party claims that the Service infringes intellectual property rights; (b) Customer indemnifying Provider for claims arising from Customer Data or Customer's use of the Service in violation of the Agreement or law; and procedures for notice, control of defense and settlement.]

## 14. General

- **Governing law and venue:** the laws of the State of Arizona [confirm], without regard to conflict-of-law rules. Venue in the state or federal courts located in [county], Arizona [confirm].
- **Notices:** in writing to the addresses on the Order Form, by [email with confirmation / courier / certified mail].
- **Assignment:** neither party may assign the Agreement without the other's consent, except to a successor in a merger or sale of substantially all assets, with notice. *[Counsel: confirm; the BAA must transfer with it.]*
- **Force majeure:** neither party is liable for delays caused by events beyond its reasonable control, except payment obligations.
- **Independent contractors:** the parties are independent contractors.
- **Entire agreement:** the Agreement is the entire agreement on its subject and supersedes prior discussions. Changes must be in writing and signed by both parties, except that Provider may update these Terms for future renewal terms with [30] days' notice.
- **Severability and waiver:** if a provision is unenforceable, the rest remains in effect. Failing to enforce a provision is not a waiver.

*[Counsel: also consider insurance requirements, publicity, non-solicitation, export control, and whether a click-through version is needed for the website.]*
