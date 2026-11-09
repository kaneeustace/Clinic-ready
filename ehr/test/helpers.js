"use strict";
/*
 * Test harness. Usage:
 *   const { start } = require("./helpers");
 *   const t = await start();                 // fresh in-memory DB, seeded, server on a random port
 *   const c = await t.login("therapist");    // keys: admin, therapist, therapist2, prescriber, frontdesk, billing
 *   const res = await c.get("/ehr/patients");          // { status, text, headers, location }
 *   await c.post("/ehr/patients", { first_name: "A" }); // CSRF token is added automatically
 *   t.db.prepare("SELECT ...").get();         // inspect DB directly
 *   await t.stop();
 */
const { openDb } = require("../src/db");
const { createApp } = require("../src/app");
const { seed, USERS } = require("../src/seed");

async function start() {
  const db = openDb(":memory:");
  const ctx = seed(db, { password: "Test-Password-123!" });
  const app = createApp(db);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = "";
    let csrf = "";
    async function request(method, path, body, { json = false, headers = {} } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      let payload;
      if (body !== undefined) {
        if (json) {
          h["content-type"] = "application/json";
          payload = JSON.stringify(body);
        } else {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(body)) {
            if (Array.isArray(v)) v.forEach((x) => params.append(k, x)); else if (v !== undefined && v !== null) params.append(k, String(v));
          }
          if (method !== "GET" && csrf && !params.has("_csrf")) params.append("_csrf", csrf);
          h["content-type"] = "application/x-www-form-urlencoded";
          payload = params.toString();
        }
      }
      if (json && csrf) h["x-csrf-token"] = csrf;
      const res = await fetch(base + path, { method, headers: h, body: payload, redirect: "manual" });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const [pair] = c.split(";");
        if (pair.startsWith("ehr_sid=")) cookie = pair.endsWith("=") ? "" : pair;
      }
      const text = await res.text();
      const m = text.match(/name="_csrf" value="([^"]+)"/);
      if (m) csrf = m[1];
      return { status: res.status, text, headers: res.headers, location: res.headers.get("location") };
    }
    const c = {
      get: (p) => request("GET", p),
      post: (p, body = {}, opts) => request("POST", p, body, opts),
      request,
      get csrf() { return csrf; },
      async refreshCsrf() { await request("GET", "/ehr"); return csrf; },
    };
    return c;
  }

  async function login(key) {
    const u = USERS.find((x) => x.key === key);
    if (!u) throw new Error("unknown user key " + key);
    const c = client();
    const res = await c.post("/ehr/login", { email: u.email, password: "Test-Password-123!" });
    if (res.status !== 302) throw new Error(`login failed for ${key}: ${res.status}`);
    await c.refreshCsrf();
    c.userId = ctx.users[key];
    return c;
  }

  return { db, ctx, base, client, login, stop: () => new Promise((r) => server.close(r)) };
}

module.exports = { start };
