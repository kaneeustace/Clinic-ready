-- Clinic Ready EHR schema. Idempotent: safe to run on every start.
-- Conventions: ids are INTEGER PRIMARY KEY; timestamps are ISO-8601 UTC text
-- (datetime('now')); clinic-local dates are 'YYYY-MM-DD'; appointment times are
-- clinic-local 'YYYY-MM-DDTHH:MM'; money is integer cents.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  credentials TEXT,                         -- e.g. 'LCSW', 'MD', 'PMHNP-BC'
  role TEXT NOT NULL CHECK (role IN ('admin','clinician','frontdesk','billing')),
  npi TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                      -- sha256 of cookie value
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  flash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,                     -- e.g. 'view', 'create', 'update', 'sign', 'login', 'login_failed'
  entity_type TEXT,                         -- e.g. 'patient', 'note'
  entity_id INTEGER,
  patient_id INTEGER,
  ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(patient_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  mrn TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  dob TEXT NOT NULL,
  sex_at_birth TEXT,
  gender_identity TEXT,
  pronouns TEXT,
  phone TEXT,
  email TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  preferred_contact TEXT CHECK (preferred_contact IN ('phone','text','email') OR preferred_contact IS NULL),
  ok_voicemail INTEGER NOT NULL DEFAULT 0,
  emergency_name TEXT,
  emergency_relation TEXT,
  emergency_phone TEXT,
  primary_clinician_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','discharged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  priority TEXT NOT NULL DEFAULT 'primary' CHECK (priority IN ('primary','secondary')),
  payer_name TEXT NOT NULL,
  member_id TEXT,
  group_number TEXT,
  subscriber_name TEXT,
  subscriber_relation TEXT,
  copay_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allergies (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  substance TEXT NOT NULL,
  reaction TEXT,
  severity TEXT CHECK (severity IN ('mild','moderate','severe') OR severity IS NULL),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  frequency TEXT,
  prescriber TEXT,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diagnoses (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  icd10_code TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  onset_date TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,                   -- clinic-local 'YYYY-MM-DDTHH:MM'
  end_at TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('intake','therapy','psychiatry_eval','med_management','family','group','consult')),
  modality TEXT NOT NULL DEFAULT 'in_person' CHECK (modality IN ('in_person','telehealth')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','checked_in','completed','no_show','cancelled','late_cancel')),
  location TEXT,
  telehealth_url TEXT,
  notes TEXT,                               -- scheduling notes only, not clinical
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appt_clinician ON appointments(clinician_id, start_at);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('intake','progress','psychiatry','psychotherapy','contact','discharge')),
  format TEXT NOT NULL DEFAULT 'dap' CHECK (format IN ('soap','dap','narrative','intake')),
  content TEXT NOT NULL DEFAULT '{}',       -- JSON object of section -> text
  risk_level TEXT CHECK (risk_level IN ('none','low','moderate','high') OR risk_level IS NULL),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  service_date TEXT,
  signed_at TEXT,
  signed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_patient ON notes(patient_id, created_at);

CREATE TABLE IF NOT EXISTS note_addenda (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treatment_plans (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','superseded')),
  start_date TEXT,
  review_date TEXT,
  summary TEXT,
  strengths TEXT,
  barriers TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treatment_goals (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  problem TEXT NOT NULL,
  goal TEXT NOT NULL,
  objectives TEXT,
  interventions TEXT,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('not_started','in_progress','met','revised','discontinued')),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  instrument TEXT NOT NULL CHECK (instrument IN ('PHQ9','GAD7')),
  responses TEXT NOT NULL,                  -- JSON array of item scores
  total_score INTEGER NOT NULL,
  severity TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,       -- e.g. PHQ-9 item 9 > 0
  administered_on TEXT NOT NULL,            -- 'YYYY-MM-DD'
  entered_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assess_patient ON assessments(patient_id, instrument, administered_on);

CREATE TABLE IF NOT EXISTS fee_schedule (
  cpt_code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  fee_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  date_of_service TEXT NOT NULL,
  cpt_code TEXT NOT NULL,
  modifier TEXT,
  units INTEGER NOT NULL DEFAULT 1,
  fee_cents INTEGER NOT NULL,
  diagnosis_codes TEXT,                     -- comma-separated ICD-10
  rendering_provider_id INTEGER REFERENCES users(id),
  bill_to TEXT NOT NULL DEFAULT 'insurance' CHECK (bill_to IN ('insurance','patient')),
  status TEXT NOT NULL DEFAULT 'unbilled' CHECK (status IN ('unbilled','billed','paid','denied','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_charges_patient ON charges(patient_id, date_of_service);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('card','cash','check','insurance','adjustment')),
  reference TEXT,
  received_on TEXT NOT NULL,
  note TEXT,
  entered_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_requests (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  dob TEXT,
  phone TEXT,
  email TEXT,
  contact_method TEXT,
  ok_voicemail TEXT,
  care_for TEXT,
  service TEXT,
  visit_preference TEXT,
  insurance TEXT,
  reason TEXT,
  referral_source TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','scheduled','closed')),
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  handled_by INTEGER REFERENCES users(id),
  staff_notes TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
