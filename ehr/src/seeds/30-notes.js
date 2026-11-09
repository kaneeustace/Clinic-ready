"use strict";
// Synthetic clinical notes: signed notes for a few completed appointments plus one draft.
// Runs inside seed()'s transaction, so no tx() here.
module.exports = function seedNotes(db, ctx) {
  const appts = db.prepare(
    `SELECT a.*, u.role FROM appointments a JOIN users u ON u.id = a.clinician_id
     WHERE a.status = 'completed' ORDER BY a.start_at LIMIT 5`).all();
  if (!appts.length) return;
  const ins = db.prepare(
    `INSERT INTO notes (patient_id, appointment_id, author_id, type, format, content, risk_level, status, service_date, signed_at, signed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const progress = (a) => ({
    session_start: a.start_at.slice(11, 16), session_end: a.end_at.slice(11, 16),
    data: "Client reported a busier week at work with moderate stress. Practiced the breathing exercise three times. (Synthetic demo text.)",
    assessment: "Engaged and receptive. Making steady progress toward the stress-management goal.",
    plan: "Continue weekly sessions. Homework: thought record twice before next visit.",
    interventions: ["CBT", "Mindfulness"], interventions_other: "", risk_narrative: "",
  });
  const psychiatry = () => ({
    chief_complaint: "Follow-up for medication management. (Synthetic demo text.)",
    interval_history: "Sleep improved; mood steadier over the past two weeks.",
    medication_response: "Tolerating current regimen; no side effects reported.",
    mse_appearance: "Well groomed", mse_behavior: "Cooperative", mse_speech: "Normal rate and volume", mse_mood: "\"Better\"",
    mse_affect: "Euthymic, congruent", mse_thought_process: "Linear", mse_thought_content: "No SI/HI",
    mse_perception: "No AVH", mse_cognition: "Grossly intact", mse_insight: "Good", mse_judgment: "Good",
    risk_narrative: "",
    assessment: "Stable on current regimen.", plan_medications: "No changes.", plan_labs: "None today.", plan_followup: "Return in 4 weeks.",
  });
  appts.forEach((a, i) => {
    const isRx = a.type === "med_management";
    const draft = i === appts.length - 1;
    const signedAt = draft ? null : `${a.start_at.slice(0, 10)} ${String(Number(a.end_at.slice(11, 13)) + 5).padStart(2, "0")}:15:00`;
    ins.run(a.patient_id, a.id, a.clinician_id, isRx ? "psychiatry" : "progress", isRx ? "soap" : "dap",
      JSON.stringify(isRx ? psychiatry() : progress(a)), "none", draft ? "draft" : "signed",
      a.start_at.slice(0, 10), signedAt, draft ? null : a.clinician_id);
  });
  void ctx;
};
