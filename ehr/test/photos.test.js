"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[0]; });
after(async () => { await t.stop(); });

// Smallest valid images (1x1) for each accepted type.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]).toString("base64");
const dataUrl = (mime, b64) => `data:${mime};base64,${b64}`;

test("upload a profile photo: shown on the Pictures tab and in the chart banner; audited", async () => {
  const c = await t.login("frontdesk");
  const tab = await c.get(`/ehr/patients/${pid}/photos`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Add a picture/);
  assert.match(tab.text, /No pictures yet/);
  const r = await c.post(`/ehr/patients/${pid}/photos`, { category: "profile", caption: "Taken at intake", image_data: dataUrl("image/png", PNG) });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const img = t.db.prepare("SELECT * FROM patient_images WHERE patient_id = ?").get(pid);
  assert.equal(img.mime, "image/png");
  assert.equal(img.is_profile, 1);
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, new RegExp(`photos/${img.id}\\?thumb=1`));
  const bytes = await c.get(`/ehr/patients/${pid}/photos/${img.id}`);
  assert.equal(bytes.status, 200);
  assert.match(bytes.headers.get("content-type"), /image\/png/);
  assert.match(bytes.headers.get("cache-control"), /no-store/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'patient_image' AND entity_id = ?").get(img.id));
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'patient_image' AND entity_id = ?").get(img.id));
});

test("a large picture (over the normal 200 KB form limit) uploads; a new profile photo replaces the old one", async () => {
  const c = await t.login("therapist");
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900 * 1024, 7)]).toString("base64");
  const r = await c.post(`/ehr/patients/${pid}/photos`, { category: "profile", image_data: dataUrl("image/jpeg", big) });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const profiles = t.db.prepare("SELECT id, mime FROM patient_images WHERE patient_id = ? AND is_profile = 1").all(pid);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].mime, "image/jpeg");
});

test("rejects files that aren't really images, unknown categories and oversize pictures", async () => {
  const c = await t.login("frontdesk");
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  let r = await c.post(`/ehr/patients/${pid}/photos`, { category: "other", image_data: dataUrl("image/png", html) });
  assert.equal(r.status, 400);
  assert.match(r.text, /isn&#39;t a JPEG|isn't a JPEG/);
  r = await c.post(`/ehr/patients/${pid}/photos`, { category: "selfie", image_data: dataUrl("image/jpeg", JPEG) });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/photos`, { category: "other", image_data: "" });
  assert.equal(r.status, 400);
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5.5 * 1024 * 1024)]).toString("base64");
  r = await c.post(`/ehr/patients/${pid}/photos`, { category: "other", image_data: dataUrl("image/jpeg", huge) });
  assert.equal(r.status, 400);
  assert.match(r.text, /too large/);
});

test("insurance card, set as profile, delete; billing can view but not upload; must be signed in", async () => {
  const c = await t.login("frontdesk");
  await c.post(`/ehr/patients/${pid}/photos`, { category: "insurance_front", image_data: dataUrl("image/jpeg", JPEG) });
  const card = t.db.prepare("SELECT id FROM patient_images WHERE patient_id = ? AND category = 'insurance_front'").get(pid);
  assert.match((await c.get(`/ehr/patients/${pid}/photos`)).text, /Insurance card \(front\)/);
  assert.equal((await c.post(`/ehr/patients/${pid}/photos/${card.id}/profile`, {})).status, 302);
  assert.equal(t.db.prepare("SELECT id FROM patient_images WHERE patient_id = ? AND is_profile = 1").get(pid).id, card.id);

  const billing = await t.login("billing");
  assert.equal((await billing.get(`/ehr/patients/${pid}/photos/${card.id}`)).status, 200);
  assert.doesNotMatch((await billing.get(`/ehr/patients/${pid}/photos`)).text, /Add a picture/);
  assert.equal((await billing.post(`/ehr/patients/${pid}/photos`, { category: "other", image_data: dataUrl("image/jpeg", JPEG) })).status, 403);

  // A picture can only be reached through its own patient.
  const other = t.ctx.patients[1];
  assert.equal((await c.get(`/ehr/patients/${other}/photos/${card.id}`)).status, 404);

  assert.equal((await c.post(`/ehr/patients/${pid}/photos/${card.id}/delete`, {})).status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patient_images WHERE id = ?").get(card.id).n, 0);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'delete' AND entity_type = 'patient_image' AND entity_id = ?").get(card.id));

  const res = await fetch(`${t.base}/ehr/patients/${pid}/photos/${card.id}`, { redirect: "manual" });
  assert.equal(res.status, 302);
});
