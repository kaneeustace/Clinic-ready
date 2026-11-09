"use strict";
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const auth = require("./auth");
const { page, html, notFound } = require("./views");

const SITE_ROOT = path.resolve(__dirname, "..", "..");     // public marketing site (repo root)
const EHR_PUBLIC = path.resolve(__dirname, "..", "public");

// Feature modules. Each exports `router` (mounted at /ehr, behind login);
// requests.js also exports `publicRouter` (mounted at /api, no login).
const MODULES = ["dashboard", "patients", "schedule", "notes", "clinical", "billing", "requests", "admin"];

function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (process.env.EHR_DEMO === "1") res.set("X-Robots-Tag", "noindex, nofollow"); // keep the demo out of search engines
  if (process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

function noStore(req, res, next) {
  // PHI must not be cached by browsers or proxies.
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
}

/** Reject cross-origin state-changing requests (defense in depth alongside SameSite + CSRF tokens). */
function sameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin") || req.get("referer");
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get("host")) return res.status(403).send("Cross-origin request blocked.");
  } catch {
    return res.status(403).send("Bad origin.");
  }
  next();
}

function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
  app.use(securityHeaders);
  app.use((req, res, next) => { req.db = db; next(); });
  app.get("/healthz", (req, res) => { db.prepare("SELECT 1").get(); res.set("Cache-Control", "no-store").json({ ok: true }); });

  /* ---------- Public marketing site: only whitelisted files from the repo root ---------- */
  app.use("/assets", express.static(path.join(SITE_ROOT, "assets"), { maxAge: "1h", dotfiles: "deny" }));
  const sitePages = new Set(fs.readdirSync(SITE_ROOT).filter((f) => f.endsWith(".html")));
  app.get("/", (req, res) => res.sendFile(path.join(SITE_ROOT, "index.html")));
  app.get("/:page", (req, res, next) => {
    let name = req.params.page;
    if (!name.endsWith(".html")) name += ".html";
    if (!sitePages.has(name)) return next();
    res.sendFile(path.join(SITE_ROOT, name));
  });

  /* ---------- Body parsing ---------- */
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(sameOrigin);

  /* ---------- Public API (website forms) ---------- */
  app.use("/api", noStore);
  for (const m of MODULES) {
    const mod = require(`./routes/${m}`);
    if (mod.publicRouter) app.use("/api", mod.publicRouter);
  }

  /* ---------- EHR ---------- */
  app.use("/ehr/static", express.static(EHR_PUBLIC, { maxAge: "1h" }));
  app.use("/ehr", noStore, auth.sessionMiddleware, auth.csrfProtection);
  app.use("/ehr", auth.router);
  app.use("/ehr", auth.requireAuth);
  for (const m of MODULES) app.use("/ehr", require(`./routes/${m}`).router);
  app.use("/ehr", (req, res) => notFound(req, res));

  /* ---------- Site 404 ---------- */
  app.use((req, res) => res.status(404).sendFile(path.join(SITE_ROOT, "404.html")));

  /* ---------- Errors ---------- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (req.path.startsWith("/api")) return res.status(status).json({ error: status >= 500 ? "server_error" : err.message });
    res.status(status).send(page(req, {
      title: "Error",
      body: html`<div class="card"><h1>Something went wrong</h1><p>${status >= 500 ? "An unexpected error occurred. It has been logged." : err.message}</p><p><a href="/ehr">Back to dashboard</a></p></div>`,
    }));
  });

  return app;
}

module.exports = { createApp };
