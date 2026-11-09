# Policy: Workstations, Mobile Devices and Media

> **TEMPLATE: REVIEW REQUIRED.** This is not legal advice. Adapt it to the devices the practice actually uses, complete the `[placeholders]`, adopt it, and have counsel review it, particularly the personal-device (BYOD) terms, which may have employment-law implications.

| | |
|---|---|
| Policy owner | Security Officer `[name]` |
| Effective date | `[date]` |
| Regulatory basis | 45 CFR 164.310(a)(1) (facility access), 164.310(b) (workstation use), 164.310(c) (workstation security), 164.310(d)(1)–(2) (device and media controls), 164.312(a)(2)(iii)–(iv) |

## 1. Scope
Covers every device used to open the EHR or other PHI systems:
- laptops, desktops, phones, and tablets, whether practice-owned or personal (BYOD);
- printers and scanners;
- any media that might hold PHI, such as USB drives, external disks, and printouts.

## 2. Why this matters for this EHR
The EHR runs in a browser, and the server sends `Cache-Control: no-store`, so pages shouldn't be stored on the device. Devices can still hold PHI in several ways:
- **downloads** (record exports, audit CSVs, superbill PDFs);
- **printouts**;
- **screenshots**;
- **an open session** on an unlocked device;
- **browser autofill**;
- **email and fax attachments**.

A lost device that is unlocked or unencrypted can be a reportable breach. A device that is **encrypted** to the HHS standard generally isn't, under the breach "safe harbor": PHI secured per HHS's *Guidance to Render Unsecured PHI Unusable, Unreadable, or Indecipherable*, https://www.hhs.gov/hipaa/for-professionals/breach-notification/guidance/index.html.

## 3. Minimum requirements for any device that accesses PHI

| Requirement | Laptop / desktop | Phone / tablet |
|---|---|---|
| Approved by the Security Officer and listed in the device inventory | ✔ | ✔ |
| Full-disk encryption on: BitLocker (Windows), FileVault (macOS) | ✔ | iOS: on whenever a passcode is set. Android: confirm encryption is on |
| Screen lock: auto-lock at `[5]` minutes or less; strong password or biometric | ✔ | ✔ 6+ digit passcode |
| Supported OS with automatic security updates on | ✔ | ✔ |
| Current browser (Chrome, Edge, Firefox, Safari) | ✔ | ✔ |
| Anti-malware: Microsoft Defender / XProtect, or `[product]` | ✔ | n/a |
| Separate user account; no shared family logins | ✔ | ✔ |
| Remote locate and wipe on (Find My / Google Find My Device / MDM `[name]`) | ✔ | ✔ |
| No jailbroken or rooted devices | | ✔ |
| Browser must **not** save EHR passwords unless it's the approved password manager | ✔ | ✔ |

## 4. Rules of use
1. **Use the EHR only through the browser.** Don't download PHI to a device unless a task requires it, such as fulfilling a records request. Delete downloads right after use and empty the trash. Never save PHI to personal cloud sync folders (iCloud Drive, personal OneDrive, personal Google Drive, Dropbox) unless the account is a practice account under a BAA.
2. **Personal phones:** allowed for EHR access only if they meet §3 and the user signs the BYOD acknowledgment below. Don't screenshot PHI. Don't text PHI over SMS or iMessage; use `[approved secure channel]`. Don't forward PHI to personal email.
3. **Public and home networks:** the EHR is HTTPS-only, so public Wi-Fi is technically acceptable. Even so, avoid public Wi-Fi for PHI when possible, and never use shared or public computers (hotel business centers, library PCs). Change the default password on home routers.
4. **Screen privacy:** position screens away from waiting areas, and use privacy filters at the front desk. Lock the screen whenever you step away.
5. **Telehealth:** hold sessions from a private room, and use headphones when others are nearby.
6. **Printing:** print only when necessary. Collect printouts immediately. Store paper with PHI in locked cabinets, and shred it with a cross-cut shredder or a bonded shredding vendor `[name]`.
7. **Removable media:** USB drives and external disks are prohibited for PHI. The only exception is an encrypted drive the Security Officer approves for off-site backup copies. Those drives are logged in the inventory.

## 5. Device inventory (accountability)

| Device ID | Type / model | Owner (practice / personal) | User | Encryption verified (date) | Remote wipe | Issued | Returned / disposed |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

The Security Officer verifies encryption and auto-lock on each device at issue and at each annual review.

## 6. Lost or stolen devices
Report a lost or stolen device to the Security Officer **immediately, and within `[1 hour]` of discovery**, by phone at `[number]`. The Security Officer will:
1. Remotely lock or wipe the device.
2. Sign out the user's sessions by deactivating and reactivating the EHR user or resetting the password; either revokes all sessions.
3. Reset MFA if the device held the authenticator.
4. Open an incident under the incident response policy. Whether the device was encrypted decides whether the breach safe harbor applies.

## 7. Disposal and re-use (164.310(d)(2)(i)–(ii))
- Before a device is re-used or disposed of, wipe it with a factory reset on an encrypted device, or with the method in NIST SP 800-88 *Guidelines for Media Sanitization*, https://csrc.nist.gov/pubs/sp/800/88/r1/final. You may also use a certified vendor's destruction certificate.
- Record the disposal in the inventory, with the method and date.
- Personal devices: when someone leaves, the Security Officer confirms the EHR, email, and authenticator data are removed. The person signs the offboarding checklist.

## 8. BYOD acknowledgment
I will use my personal device `[make/model]` to access practice systems only in line with this policy. I confirm the device is encrypted, auto-locks, is updated, and has remote wipe enabled. I will report loss right away. I agree that the practice may require removal of practice data when my employment or contract ends.

Name: ____________________ Signature: ____________________ Date: ________

## 9. Adoption
Adopted by: ____________________ Date: ________. Keep for 6 years.
