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
  type TEXT NOT NULL CHECK (type IN ('intake','progress','psychiatry','psychotherapy','contact','discharge','group','safety_plan','asam','roi','supportive_housing')),
  format TEXT NOT NULL DEFAULT 'dap' CHECK (format IN ('soap','dap','narrative','intake','group','safety_plan','asam','roi','supportive_housing')),
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
  instrument TEXT NOT NULL CHECK (instrument IN ('PHQ9','GAD7','CSSRS','AUDIT','DAST10','PCL5','MDQ','ASRS')),
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

-- ---------------------------------------------------------------------------
-- Treatment plan v2 (person-centered, measurable, versioned). See docs/treatment-plan-spec.md.
-- treatment_plans gains columns via migrate() in db.js (ALTER TABLE ADD COLUMN).
-- The legacy treatment_goals table is kept read-only for history; new plans use the tables below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_problems (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,                      -- e.g. 'Depressed mood'
  behavioral_definition TEXT,               -- how it shows up for this client (frequency, impact)
  icd10_code TEXT,                          -- linked diagnosis
  asam_dimension INTEGER CHECK (asam_dimension BETWEEN 1 AND 6 OR asam_dimension IS NULL),
  is_driver INTEGER NOT NULL DEFAULT 0,     -- ASAM dimensional driver of level of care
  stage_of_change TEXT CHECK (stage_of_change IN ('precontemplation','contemplation','preparation','action','maintenance') OR stage_of_change IS NULL),
  priority TEXT CHECK (priority IN ('high','medium','low') OR priority IS NULL),
  barriers TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','deferred','referred'))
);
CREATE TABLE IF NOT EXISTS plan_goals (
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL REFERENCES plan_problems(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  client_words TEXT,                        -- verbatim, in the client's own words
  goal_text TEXT NOT NULL                   -- clinical restatement of the long-term goal
);
CREATE TABLE IF NOT EXISTS plan_objectives (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES plan_goals(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,                       -- SMART statement
  measure_type TEXT NOT NULL DEFAULT 'attainment' CHECK (measure_type IN ('instrument','frequency','duration','rating','attainment')),
  instrument TEXT,                          -- e.g. 'PHQ9' when measure_type = 'instrument'
  baseline_value REAL,
  target_value REAL,
  direction TEXT CHECK (direction IN ('decrease','increase','achieve') OR direction IS NULL),
  unit TEXT,                                -- e.g. 'times per week', 'hours per day'
  measurement_method TEXT,                  -- how and how often it is measured
  target_date TEXT,
  linked_strength TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','progressing','partially_met','met','not_met','regressed','revised','discontinued')),
  current_value REAL,
  current_value_on TEXT
);
CREATE TABLE IF NOT EXISTS plan_interventions (
  id INTEGER PRIMARY KEY,
  objective_id INTEGER NOT NULL REFERENCES plan_objectives(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'professional' CHECK (kind IN ('professional','self_directed','natural_support')),
  modality TEXT,                            -- e.g. 'CBT', 'Medication management', 'Peer support'
  description TEXT NOT NULL,                -- specific technique / action and its purpose
  frequency TEXT,                           -- e.g. 'Weekly, 53 min'
  duration TEXT,                            -- e.g. '12 weeks' / '12 sessions'
  responsible_user_id INTEGER REFERENCES users(id),
  responsible_text TEXT                     -- when not a staff member (client, family, peer)
);
CREATE TABLE IF NOT EXISTS plan_signatures (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('clinician','client','guardian','supervisor')),
  signer_user_id INTEGER REFERENCES users(id),  -- staff signers
  signer_name TEXT NOT NULL,
  method TEXT CHECK (method IN ('password','in_person','electronic','verbal') OR method IS NULL),
  declined INTEGER NOT NULL DEFAULT 0,      -- client/guardian declined or unable to sign
  declined_reason TEXT,
  copy_offered INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plan_reviews (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  participants TEXT,
  client_perspective TEXT,
  summary TEXT,
  diagnosis_changes TEXT,
  level_of_care_appropriate INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('continue','revise','discharge')),
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plan_review_items (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES plan_reviews(id) ON DELETE CASCADE,
  objective_id INTEGER NOT NULL REFERENCES plan_objectives(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  current_value REAL,
  rationale TEXT,
  action TEXT CHECK (action IN ('continue','modify','change_intervention','close') OR action IS NULL)
);
-- Golden thread: which objectives a progress note addressed.
CREATE TABLE IF NOT EXISTS note_objectives (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  objective_id INTEGER NOT NULL REFERENCES plan_objectives(id) ON DELETE CASCADE,
  progress TEXT CHECK (progress IN ('progressing','no_change','regressed','met') OR progress IS NULL),
  comment TEXT,
  PRIMARY KEY (note_id, objective_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_problems_plan ON plan_problems(plan_id, sort);
CREATE INDEX IF NOT EXISTS idx_plan_goals_problem ON plan_goals(problem_id, sort);
CREATE INDEX IF NOT EXISTS idx_plan_objectives_goal ON plan_objectives(goal_id, sort);
CREATE INDEX IF NOT EXISTS idx_plan_interventions_obj ON plan_interventions(objective_id, sort);
CREATE INDEX IF NOT EXISTS idx_note_objectives_obj ON note_objectives(objective_id);

-- ---------------------------------------------------------------------------
-- HIPAA hardening (see docs/hipaa/). users/sessions/audit_log columns are added in db.js migrate().
-- ---------------------------------------------------------------------------
-- Accounting of disclosures (45 CFR 164.528) and release tracking.
CREATE TABLE IF NOT EXISTS disclosures (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  disclosed_on TEXT NOT NULL,               -- 'YYYY-MM-DD'
  recipient TEXT NOT NULL,                  -- name / organization / address
  purpose TEXT NOT NULL,
  description TEXT NOT NULL,                -- what information was disclosed
  basis TEXT NOT NULL CHECK (basis IN ('authorization','patient_request','required_by_law','public_health','health_oversight','judicial','law_enforcement','treatment','payment','operations','other')),
  authorization_note_id INTEGER REFERENCES notes(id),  -- linked release-of-information consent
  includes_part2 INTEGER NOT NULL DEFAULT 0,          -- substance use disorder records (42 CFR Part 2)
  method TEXT,                              -- fax, mail, portal, secure email, in person
  entered_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disclosures_patient ON disclosures(patient_id, disclosed_on);

-- Security events surfaced to administrators (failed-login bursts, unusual access, break-glass, etc.).
CREATE TABLE IF NOT EXISTS security_alerts (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,                       -- e.g. 'failed_logins', 'bulk_access', 'after_hours', 'audit_chain_broken', 'backup_failed'
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  user_id INTEGER REFERENCES users(id),
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  detail TEXT,                              -- no PHI
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_status ON security_alerts(status, ts);

-- Patient pictures: profile photo, photo ID, insurance cards, other. Stored in the database so they are covered
-- by access control, the audit log and encrypted backups. Images are re-encoded client-side (EXIF stripped).
CREATE TABLE IF NOT EXISTS patient_images (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('profile','photo_id','insurance_front','insurance_back','other')),
  caption TEXT,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  is_profile INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_images_patient ON patient_images(patient_id, created_at);

-- Level of care: episodes (one open episode per patient = current level) and payer authorizations / utilization review.
CREATE TABLE IF NOT EXISTS loc_episodes (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  asam_level TEXT,
  program TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  reason TEXT,
  end_reason TEXT,
  end_note TEXT,
  created_by INTEGER REFERENCES users(id),
  ended_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loc_episodes_patient ON loc_episodes(patient_id, start_date);
CREATE INDEX IF NOT EXISTS idx_loc_episodes_open ON loc_episodes(end_date, level);

CREATE TABLE IF NOT EXISTS loc_authorizations (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES loc_episodes(id) ON DELETE SET NULL,
  level TEXT NOT NULL,
  payer TEXT,
  auth_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('requested','pending','approved','denied','expired','closed')),
  unit_type TEXT NOT NULL DEFAULT 'days' CHECK (unit_type IN ('days','sessions','units')),
  units_approved INTEGER,
  units_used INTEGER,
  start_date TEXT,
  end_date TEXT,
  next_review_date TEXT,
  reviewer TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loc_auth_patient ON loc_authorizations(patient_id, start_date);
CREATE INDEX IF NOT EXISTS idx_loc_auth_review ON loc_authorizations(status, next_review_date);

-- End-of-day outstanding-notes emails (src/digest.js). One row per user per day; runs record the scheduler.
CREATE TABLE IF NOT EXISTS digest_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','nothing','failed')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, run_date)
);
CREATE TABLE IF NOT EXISTS digest_runs (
  run_date TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  sent INTEGER, skipped INTEGER, failed INTEGER
);

-- Clinic (practice) identity and branding. Exactly one row (id = 1). See src/clinic.js.
CREATE TABLE IF NOT EXISTS clinic_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  tagline TEXT,
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, zip TEXT,
  phone TEXT, fax TEXT, email TEXT, website TEXT,
  npi TEXT, tax_id TEXT, taxonomy TEXT,
  color TEXT NOT NULL DEFAULT 'blue',
  logo BLOB, logo_mime TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Calendar color for each appointment type (Administration → Appointment colors). Missing rows use defaults.
CREATE TABLE IF NOT EXISTS appointment_type_colors (
  type TEXT PRIMARY KEY,
  color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per server start. If the count resets after a deploy, the database didn't survive (disk not kept).
CREATE TABLE IF NOT EXISTS server_starts (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  version TEXT
);

-- Client self check-in on their phone (src/routes/checkin.js). One row per appointment.
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE,
  token_expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link','lobby')),
  step TEXT NOT NULL DEFAULT 'contact',
  started_at TEXT,
  completed_at TEXT,
  contact_changes TEXT,
  contact_applied INTEGER NOT NULL DEFAULT 0,
  insurance_changed INTEGER,
  insurance_payer TEXT,
  insurance_member_id TEXT,
  consent_name TEXT,
  consent_at TEXT,
  phq9_id INTEGER REFERENCES assessments(id) ON DELETE SET NULL,
  gad7_id INTEGER REFERENCES assessments(id) ON DELETE SET NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  quick INTEGER NOT NULL DEFAULT 0,
  link_sent_at TEXT,
  link_sent_via TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_patient ON checkins(patient_id, created_at);

-- Front-desk check-in kiosks (e.g. an iPad in the lobby). The device keeps a long-lived cookie; only its hash is stored.
CREATE TABLE IF NOT EXISTS checkin_kiosks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
