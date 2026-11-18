"use strict";
// Demo clinic identity (fictional): shows what a customer's branded copy looks like.
module.exports = function seedClinic(db) {
  if (process.env.EHR_DEMO !== "1") return; // tests keep the default identity
  db.prepare(`UPDATE clinic_settings SET name = 'Sunrise Behavioral Health', tagline = 'Demo clinic · fictional data',
    address1 = '100 Example Way', city = 'Phoenix', state = 'AZ', zip = '85004', phone = '(602) 555-0100',
    npi = '1234567893', tax_id = '86-0000000', color = 'teal' WHERE id = 1`).run();
};
