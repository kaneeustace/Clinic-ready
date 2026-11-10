"use strict";
/*
 * Clinic (practice) identity and branding: name, logo, address, NPI, tax ID and brand color.
 * One row in clinic_settings. Used by the app shell, login, printouts, superbills, emails and the
 * home-screen app name. Defaults come from EHR_CLINIC_NAME, then "Clinic Ready".
 */
const COLORS = {
  blue: { label: "Blue", primary: "#315de7", dark: "#2448c2", light: "#eaf0fe", ring: "rgba(49,93,231,.18)" },
  teal: { label: "Teal", primary: "#0f8f86", dark: "#0b6f68", light: "#e3f5f3", ring: "rgba(15,143,134,.2)" },
  purple: { label: "Purple", primary: "#6d4ae0", dark: "#5534c2", light: "#efeafd", ring: "rgba(109,74,224,.18)" },
  green: { label: "Green", primary: "#1f8a4c", dark: "#176b3a", light: "#e6f5ec", ring: "rgba(31,138,76,.2)" },
  rose: { label: "Rose", primary: "#d1406b", dark: "#ab2f55", light: "#fdebf0", ring: "rgba(209,64,107,.18)" },
  slate: { label: "Slate", primary: "#3f5677", dark: "#2f425d", light: "#e9eef5", ring: "rgba(63,86,119,.2)" },
};
const FIELDS = ["name", "tagline", "address1", "address2", "city", "state", "zip", "phone", "fax", "email", "website", "npi", "tax_id", "taxonomy", "color"];

function defaultName() { return String(process.env.EHR_CLINIC_NAME || "").trim().slice(0, 120) || "Clinic Ready"; }

/** Ensure the settings row exists (seeded from EHR_CLINIC_NAME). */
function ensureClinic(db) {
  db.prepare("INSERT OR IGNORE INTO clinic_settings (id, name) VALUES (1, ?)").run(defaultName());
}

/** Clinic settings plus derived fields. Never returns the logo bytes. */
function getClinic(db) {
  let row = null;
  try { row = db.prepare(`SELECT ${FIELDS.join(", ")}, logo_mime, length(logo) AS logo_bytes, updated_at FROM clinic_settings WHERE id = 1`).get(); } catch { row = null; }
  const c = row || { name: defaultName(), color: "blue" };
  const cityLine = [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    ...c,
    color: COLORS[c.color] ? c.color : "blue",
    hasLogo: !!(row && row.logo_bytes),
    logoUrl: row && row.logo_bytes ? `/ehr/brand/logo?v=${encodeURIComponent(c.updated_at || "")}` : null,
    tagline: c.tagline || "Behavioral Health EHR",
    addressLines: [c.address1, c.address2, cityLine].filter(Boolean),
    address: [c.address1, c.address2, cityLine].filter(Boolean).join(", "),
    billingReady: !!(c.npi && c.tax_id && c.address1),
  };
}

/** Inline CSS that applies the brand color (CSP allows inline styles). */
function brandCss(c) {
  const k = COLORS[c.color] || COLORS.blue;
  if (c.color === "blue") return "";
  return `:root{--primary:${k.primary};--primary-dark:${k.dark};--primary-light:${k.light};--primary-ring:${k.ring}}`;
}

module.exports = { COLORS, FIELDS, getClinic, ensureClinic, brandCss, defaultName };
