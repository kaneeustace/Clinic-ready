"use strict";
/*
 * Clinic (practice) identity and branding: name, logo, address, NPI, tax ID and brand color.
 * One row in clinic_settings. Used by the app shell, login, printouts, superbills, emails and the
 * home-screen app name. Defaults come from EHR_CLINIC_NAME, then the product name (ChartReady).
 */
const COLORS = {
  blue: { label: "Blue", primary: "#2b5c8f", dark: "#1f4670", light: "#eaf0f6", ring: "rgba(43,92,143,.22)" },
  teal: { label: "Teal", primary: "#1d7069", dark: "#155650", light: "#e6f1ef", ring: "rgba(29,112,105,.22)" },
  purple: { label: "Purple", primary: "#5a4a96", dark: "#463978", light: "#eeebf5", ring: "rgba(90,74,150,.22)" },
  green: { label: "Green", primary: "#2f6b45", dark: "#245336", light: "#e8f1eb", ring: "rgba(47,107,69,.22)" },
  rose: { label: "Rose", primary: "#9c3d5a", dark: "#7c2f47", light: "#f5e9ed", ring: "rgba(156,61,90,.22)" },
  slate: { label: "Slate", primary: "#3f5677", dark: "#2f425d", light: "#e9eef5", ring: "rgba(63,86,119,.22)" },
};
const FIELDS = ["name", "tagline", "address1", "address2", "city", "state", "zip", "phone", "fax", "email", "website", "npi", "tax_id", "taxonomy", "color"];

function defaultName() { return String(process.env.EHR_CLINIC_NAME || "").trim().slice(0, 120) || require("./product").PRODUCT.name; }

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
