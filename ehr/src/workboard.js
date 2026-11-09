"use strict";
/*
 * Dashboard workboard: To do / In progress / Done for a clinician's documentation, with signature deadlines.
 *   To do        sessions (completed or checked in) that have no note yet          due: session end + SIGN_HOURS
 *   In progress  the clinician's unsigned drafts                                    due: session end + SIGN_HOURS
 *                their signed notes waiting on the supervisor's co-signature         due: signed + COSIGN_HOURS
 *                (supervisors) supervisees' notes waiting on their co-signature      due: signed + COSIGN_HOURS
 *   Done         notes fully signed (and co-signed when required) in the last 7 days
 */
const { html, patientName, fmtDateTime, fmtDate, humanize, today, addDays } = require("./views");
const { countdown } = require("./countdown");
const sup = require("./supervision");

const typeLabel = (t) => ({ progress: "Progress note", intake: "Intake assessment", group: "Group note", psychiatry: "Psychiatry note",
  contact: "Contact note", discharge: "Discharge summary", safety_plan: "Safety plan", asam: "ASAM assessment", roi: "Release of information",
  supportive_housing: "Supportive housing", psychotherapy: "Psychotherapy note" }[t] || humanize(t));

function buildWorkboard(db, user) {
  const signH = sup.SIGN_HOURS(), cosignH = sup.COSIGN_HOURS();
  const since = addDays(today(), -30);
  const items = { todo: [], progress: [], done: [] };

  // To do: my sessions without a note
  const appts = db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.clinician_id = ? AND a.status IN ('completed','checked_in') AND substr(a.start_at,1,10) >= ?
       AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.appointment_id = a.id)
     ORDER BY a.start_at`).all(user.id, since);
  for (const a of appts) {
    const end = sup.localToMs(a.end_at.slice(0, 10), a.end_at.slice(11, 16));
    items.todo.push({ kind: "write", patient: a, patientId: a.patient_id, title: `${humanize(a.type)} on ${fmtDateTime(a.start_at)}`,
      what: "Write and sign the note", dueMs: end + signH * 3.6e6, total: signH,
      href: `/ehr/patients/${a.patient_id}/notes/new?appointment_id=${a.id}`, action: "Write note" });
  }

  // In progress (a): my drafts
  const drafts = db.prepare(
    `SELECT n.*, p.first_name, p.last_name, p.preferred_name, ap.end_at AS appt_end FROM notes n JOIN patients p ON p.id = n.patient_id
     LEFT JOIN appointments ap ON ap.id = n.appointment_id WHERE n.author_id = ? AND n.status = 'draft' ORDER BY n.created_at`).all(user.id);
  for (const n of drafts) {
    const end = sup.serviceEndMs(n, n.appt_end ? { end_at: n.appt_end } : null) || Date.parse(n.created_at.replace(" ", "T") + "Z");
    items.progress.push({ kind: "sign", patient: n, patientId: n.patient_id, title: `${typeLabel(n.type)}${n.service_date ? ` · ${fmtDate(n.service_date)}` : ""}`,
      what: "Waiting on your signature", dueMs: end + signH * 3.6e6, total: signH, href: `/ehr/notes/${n.id}`, action: "Review & sign" });
  }

  // In progress (b): my notes waiting on my supervisor
  const waiting = db.prepare(
    `SELECT n.*, p.first_name, p.last_name, p.preferred_name, s.name AS sup_name FROM notes n JOIN patients p ON p.id = n.patient_id
     JOIN users me ON me.id = n.author_id LEFT JOIN users s ON s.id = me.supervisor_id
     WHERE n.author_id = ? AND n.status = 'signed' AND n.cosign_required = 1 AND n.cosigned_at IS NULL ORDER BY n.cosign_due_at`).all(user.id);
  for (const n of waiting) {
    items.progress.push({ kind: "await", patient: n, patientId: n.patient_id, title: `${typeLabel(n.type)}${n.service_date ? ` · ${fmtDate(n.service_date)}` : ""}`,
      what: `Waiting on ${n.sup_name ? `${n.sup_name}'s` : "a supervisor's"} co-signature`, dueMs: sup.utcToMs(n.cosign_due_at), total: cosignH,
      href: `/ehr/notes/${n.id}`, action: "View" });
  }

  // In progress (c): supervisees' notes waiting on me
  if (sup.canSupervise(user)) {
    const mine = db.prepare(
      `SELECT n.*, p.first_name, p.last_name, p.preferred_name, a.name AS author_name, a.credentials AS author_credentials
       FROM notes n JOIN patients p ON p.id = n.patient_id JOIN users a ON a.id = n.author_id
       WHERE n.status = 'signed' AND n.cosign_required = 1 AND n.cosigned_at IS NULL AND n.author_id <> ?
         AND (a.supervisor_id = ? OR (a.supervisor_id IS NULL AND ? = 'admin'))
       ORDER BY n.cosign_due_at`).all(user.id, user.id, user.role);
    for (const n of mine) {
      items.progress.push({ kind: "cosign", patient: n, patientId: n.patient_id, title: `${typeLabel(n.type)} by ${n.author_name}${n.author_credentials ? `, ${n.author_credentials}` : ""}`,
        what: "Needs your co-signature", dueMs: sup.utcToMs(n.cosign_due_at), total: cosignH, href: `/ehr/notes/${n.id}`, action: "Review & co-sign" });
    }
  }

  // Done: fully signed in the last 7 days (mine, or co-signed by me)
  const done = db.prepare(
    `SELECT n.*, p.first_name, p.last_name, p.preferred_name FROM notes n JOIN patients p ON p.id = n.patient_id
     WHERE n.status = 'signed' AND (n.cosign_required = 0 OR n.cosigned_at IS NOT NULL)
       AND ((n.author_id = ? AND COALESCE(n.cosigned_at, n.signed_at) >= datetime('now','-7 days'))
         OR (n.cosigned_by = ? AND n.cosigned_at >= datetime('now','-7 days')))
     ORDER BY COALESCE(n.cosigned_at, n.signed_at) DESC LIMIT 15`).all(user.id, user.id);
  for (const n of done) {
    items.done.push({ kind: "done", patient: n, patientId: n.patient_id, title: `${typeLabel(n.type)}${n.service_date ? ` · ${fmtDate(n.service_date)}` : ""}`,
      what: n.cosigned_at ? (n.cosigned_by === user.id && n.author_id !== user.id ? "You co-signed" : "Signed and co-signed") : "Signed",
      href: `/ehr/notes/${n.id}`, action: "View" });
  }

  const now = Date.now();
  const urgent = [...items.todo, ...items.progress].filter((i) => i.dueMs != null && i.dueMs - now < 12 * 3.6e6)
    .sort((a, b) => a.dueMs - b.dueMs);
  items.todo.sort((a, b) => a.dueMs - b.dueMs);
  items.progress.sort((a, b) => a.dueMs - b.dueMs);
  return { ...items, urgent, signH, cosignH };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function card(i) {
  return html`<li class="wb-card wb-card--${i.kind}">
    <div class="wb-card__top"><a href="/ehr/patients/${i.patientId}"><strong>${patientName(i.patient)}</strong></a>
      ${i.dueMs != null ? countdown(iso(i.dueMs), i.total) : html`<span class="badge badge--good">Done</span>`}</div>
    <p class="wb-card__title">${i.title}</p>
    <p class="wb-card__what muted small">${i.what}</p>
    <a class="btn btn--sm${i.kind === "done" || i.kind === "await" ? "" : " btn--primary"}" href="${i.href}">${i.action}</a>
  </li>`;
}

function renderWorkboard(wb) {
  const col = (key, title, list, empty) => html`
    <section class="wb-col wb-col--${key}" aria-labelledby="wb-${key}">
      <h3 id="wb-${key}">${title} <span class="pill">${list.length}</span></h3>
      ${list.length ? html`<ul class="wb-list">${list.map(card)}</ul>` : html`<p class="muted small">${empty}</p>`}
    </section>`;
  return html`
    ${wb.urgent.length ? html`
      <section class="card card--alert wb-alert" role="alert" aria-labelledby="wb-alert-h">
        <h2 id="wb-alert-h">Signatures due</h2>
        <p class="muted small">Clinicians sign within ${wb.signH} hours of the session; supervisors co-sign within ${wb.cosignH} hours of the clinician's signature.</p>
        <ul class="list-plain">${wb.urgent.map((i) => html`<li class="row">
          ${countdown(iso(i.dueMs), i.total)} <a href="${i.href}"><strong>${patientName(i.patient)}</strong></a>
          <span class="muted">${i.title} · ${i.what}</span></li>`)}</ul>
      </section>` : ""}
    <section class="card" aria-labelledby="wb-h">
      <div class="card__head"><h2 id="wb-h">Workboard</h2>
        <span class="muted small">Sign within ${wb.signH} h of the session · supervisor co-signs within ${wb.cosignH} h</span></div>
      <div class="wb">
        ${col("todo", "To do", wb.todo, "No sessions waiting for a note.")}
        ${col("progress", "In progress", wb.progress, "Nothing waiting on a signature.")}
        ${col("done", "Done", wb.done, "Nothing signed in the last 7 days.")}
      </div>
    </section>`;
}

module.exports = { buildWorkboard, renderWorkboard };
