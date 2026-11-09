"use strict";

/**
 * Append an entry to the audit log. Call for every view or change of PHI.
 *   audit(req, 'view', 'patient', patient.id, patient.id)
 *   audit(req, 'sign', 'note', note.id, note.patient_id)
 * Never put PHI content in `detail`; record what happened, not the data itself.
 */
function audit(req, action, entityType = null, entityId = null, patientId = null, detail = null) {
  req.db.prepare(
    "INSERT INTO audit_log (user_id, action, entity_type, entity_id, patient_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(req.user ? req.user.id : null, action, entityType, entityId == null ? null : Number(entityId),
    patientId == null ? null : Number(patientId), req.ip || null, detail == null ? null : String(detail).slice(0, 500));
}

module.exports = { audit };
