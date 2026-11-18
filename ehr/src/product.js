"use strict";
/*
 * The product (the software you sell), as opposed to each customer's clinic (src/clinic.js).
 * Shown as "Powered by ChartReady", on the sales site (/software), and as the default name before a clinic is set up.
 */
const PRODUCT = Object.freeze({
  name: "ChartReady",
  tagline: "Behavioral health EHR",
});
const salesEmail = () => String(process.env.EHR_SALES_EMAIL || "").trim();
/** Public demo sign-in page; empty until EHR_DEMO_URL is set (the sales page then hides "Try the live demo"). */
const demoUrl = () => String(process.env.EHR_DEMO_URL || "").trim();

module.exports = { PRODUCT, salesEmail, demoUrl };
