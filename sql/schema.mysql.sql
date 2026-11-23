-- Collaborative Research Platform — MySQL / MariaDB schema (OVH)
-- Import with phpMyAdmin or: php bin/install.php
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  orcid VARCHAR(19) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL DEFAULT '',
  email VARCHAR(255) NULL,
  affiliation VARCHAR(255) NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'human',  -- 'human' | 'agent' (AI agent using an API token)
  ai_model VARCHAR(120) NULL,                 -- for agents: the AI system behind it
  tours_seen VARCHAR(60) NULL,                -- first-use tutorials already seen
  created_at DATETIME NOT NULL,
  last_login_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  question_html MEDIUMTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_members (
  project_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at DATETIME NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Content-addressed binary storage (files live in storage/blobs/xx/yy/sha256)
CREATE TABLE IF NOT EXISTS blobs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sha256 CHAR(64) NOT NULL UNIQUE,
  size BIGINT UNSIGNED NOT NULL,
  mime VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bib_entries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  cite_key VARCHAR(190) NOT NULL,
  entry_type VARCHAR(40) NOT NULL DEFAULT 'article',
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  year VARCHAR(10) NULL,
  venue VARCHAR(500) NULL,
  doi VARCHAR(255) NULL,
  url VARCHAR(1000) NULL,
  fields_json MEDIUMTEXT NOT NULL,
  pdf_blob_id INT UNSIGNED NULL,
  pdf_uploaded_by INT UNSIGNED NULL,
  pdf_uploaded_at DATETIME NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_bib_key (project_id, cite_key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (pdf_blob_id) REFERENCES blobs(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS documents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  origin VARCHAR(10) NOT NULL,            -- 'human' | 'ai'
  ai_model VARCHAR(120) NULL,             -- e.g. model used when origin = 'ai'
  current_version_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_versions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  document_id INT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  notes TEXT NULL,
  restored_from_id INT UNSIGNED NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  uploaded_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_doc_version (document_id, version_no),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS version_files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  version_id INT UNSIGNED NOT NULL,
  role VARCHAR(10) NOT NULL,              -- 'pdf' | 'source' | 'bib'
  filename VARCHAR(255) NOT NULL,
  blob_id INT UNSIGNED NOT NULL,
  FOREIGN KEY (version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (blob_id) REFERENCES blobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  subject VARCHAR(255) NOT NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  last_message_at DATETIME NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  last_read_at DATETIME NULL,
  starred TINYINT(1) NOT NULL DEFAULT 0,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  body_html MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  edited_at DATETIME NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comment threads on conversations, documents and bibliography entries.
-- anchor_json (root comments only) pins the thread to a PDF selection
-- {version_id|blob_id, page, quote, rects} or to a message {message_id, quote}.
CREATE TABLE IF NOT EXISTS comments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  target_type VARCHAR(20) NOT NULL,       -- 'conversation' | 'document' | 'bib' | 'fact' | 'oquestion' | 'strategy'
  target_id INT UNSIGNED NOT NULL,
  parent_id INT UNSIGNED NULL,
  author_id INT UNSIGNED NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  body_html MEDIUMTEXT NOT NULL,
  anchor_json TEXT NULL,
  resolved TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  edited_at DATETIME NULL,
  KEY idx_comment_target (target_type, target_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mentions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  source_type VARCHAR(20) NOT NULL,       -- 'message' | 'comment' | 'project'
  source_id INT UNSIGNED NOT NULL,
  mentioned_type VARCHAR(20) NOT NULL,    -- 'user' | 'document' | 'bib' | 'fact' | 'question' | 'strategy'
  mentioned_id INT UNSIGNED NOT NULL,
  KEY idx_mention_source (source_type, source_id),
  KEY idx_mention_target (mentioned_type, mentioned_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  kind VARCHAR(30) NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  read_at DATETIME NULL,
  KEY idx_notif_user (user_id, read_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API tokens for AI agents. Each agent is a user (kind = 'agent') that is a member of
-- exactly one project with role 'agent'. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  agent_user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fact database: a dependency graph (DAG) of mathematical statements.
-- Content lives in immutable revisions. Reviews and Lean proofs apply to one revision.
CREATE TABLE IF NOT EXISTS facts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  label VARCHAR(120) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  title VARCHAR(255) NOT NULL,
  current_revision INT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(10) NOT NULL,            -- who produced the mathematics: 'human' | 'ai'
  method VARCHAR(12) NOT NULL,            -- 'extracted' (from a source) | 'deduced'
  proof_origin VARCHAR(8) NOT NULL DEFAULT 'none', -- 'human' | 'ai' | 'mixed' | 'none'
  labels_json TEXT NULL,                  -- Danus labels: counterexample, conclusion...
  tool VARCHAR(60) NULL,                  -- e.g. 'danus'
  external_id VARCHAR(64) NULL,           -- e.g. the Danus fact_id
  ai_model VARCHAR(120) NULL,             -- model that wrote this entry
  retracted_at DATETIME NULL,
  retracted_by INT UNSIGNED NULL,
  retract_reason TEXT NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  UNIQUE KEY uq_fact_label (project_id, label),
  UNIQUE KEY uq_fact_external (project_id, external_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_revisions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fact_id INT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  statement_html MEDIUMTEXT NOT NULL,
  proof_html MEDIUMTEXT NULL,
  intuition_html MEDIUMTEXT NULL,
  deps_json TEXT NULL,
  proof_origin VARCHAR(8) NOT NULL DEFAULT 'none',
  glossary_json MEDIUMTEXT NULL,
  external_refs_json MEDIUMTEXT NULL,
  origin VARCHAR(10) NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  notes TEXT NULL,
  author_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_fact_revision (fact_id, revision_no),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_deps (
  fact_id INT UNSIGNED NOT NULL,
  depends_on_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (fact_id, depends_on_id),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES facts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fact_id INT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  reviewer_id INT UNSIGNED NOT NULL,
  reviewer_kind VARCHAR(10) NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  verdict VARCHAR(12) NOT NULL,
  body_html MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_fact_review (fact_id, revision_no, reviewer_id, reviewer_kind),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_lean (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fact_id INT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  code MEDIUMTEXT NOT NULL,
  decl_name VARCHAR(255) NULL,
  lean_version VARCHAR(60) NULL,
  mathlib_rev VARCHAR(80) NULL,
  url VARCHAR(500) NULL,
  origin VARCHAR(10) NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,           -- user this AI output was produced for
  ai_generation_ms INT UNSIGNED NULL,     -- generation time, when the client measured it
  incomplete TINYINT(1) NOT NULL DEFAULT 0,
  check_status VARCHAR(10) NOT NULL DEFAULT 'unchecked',
  check_log TEXT NULL,
  checked_by INT UNSIGNED NULL,
  check_model VARCHAR(120) NULL,
  check_user_id INT UNSIGNED NULL,
  check_generation_ms INT UNSIGNED NULL,
  checked_at DATETIME NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where a fact comes from. Quotes from private conversations are shown to participants only.
CREATE TABLE IF NOT EXISTS fact_sources (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fact_id INT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  source_type VARCHAR(12) NOT NULL,       -- 'document' | 'bib' | 'message' | 'comment'
  source_id INT UNSIGNED NOT NULL,
  version_id INT UNSIGNED NULL,
  conversation_id INT UNSIGNED NULL,
  page INT UNSIGNED NULL,
  quote TEXT NOT NULL,
  is_human TINYINT(1) NOT NULL DEFAULT 1,
  covers VARCHAR(10) NOT NULL DEFAULT 'context', -- 'statement' | 'proof' | 'both' | 'context'
  author_user_id INT UNSIGNED NULL,
  author_name VARCHAR(500) NULL,
  author_basis VARCHAR(20) NULL,          -- how the credit is known
  KEY idx_fact_source (fact_id, revision_no),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Personal API keys: a user's AI client reads what the user can read and submits facts.
CREATE TABLE IF NOT EXISTS user_api_keys (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ordered log of changes, used to compute what each user has not read yet.
CREATE TABLE IF NOT EXISTS activity (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  item_type VARCHAR(12) NOT NULL,         -- conversation, fact, document, bib, question, oquestion, strategy, member
  item_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NULL,             -- NULL for a user's AI client: its work is new to that user
  kind VARCHAR(20) NOT NULL,
  ref_id INT UNSIGNED NULL,               -- e.g. the comment concerned
  created_at DATETIME NOT NULL,
  KEY idx_activity_item (project_id, item_type, item_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What each user has read. item_id = 0 marks a whole item type as read up to activity_id.
CREATE TABLE IF NOT EXISTS read_marks (
  user_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  item_type VARCHAR(12) NOT NULL,
  item_id INT UNSIGNED NOT NULL,
  activity_id INT UNSIGNED NOT NULL DEFAULT 0,
  forced_unread TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, project_id, item_type, item_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS open_questions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  parent_id INT UNSIGNED NULL,            -- NULL for a big question
  title VARCHAR(255) NOT NULL,
  statement_html MEDIUMTEXT NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  priority VARCHAR(8) NOT NULL DEFAULT 'normal',
  ai_model VARCHAR(120) NULL,             -- model behind the current wording, NULL if human
  ai_user_id INT UNSIGNED NULL,
  ai_generation_ms INT UNSIGNED NULL,
  created_by INT UNSIGNED NOT NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  KEY idx_question_project (project_id, parent_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES open_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS proof_strategies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'idea',
  current_revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  KEY idx_strategy_question (question_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES open_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_revisions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  strategy_id INT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(12) NOT NULL,
  body_html MEDIUMTEXT NOT NULL,
  change_note VARCHAR(500) NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,
  ai_generation_ms INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_strategy_revision (strategy_id, revision_no),
  FOREIGN KEY (strategy_id) REFERENCES proof_strategies(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_links (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NOT NULL,
  strategy_id INT UNSIGNED NOT NULL DEFAULT 0,  -- 0 when the link is on the question itself
  target_type VARCHAR(12) NOT NULL,       -- fact, document, bib
  target_id INT UNSIGNED NOT NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_question_link (question_id, strategy_id, target_type, target_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES open_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_answers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NOT NULL,
  fact_id INT UNSIGNED NOT NULL,          -- the fact that would answer the question
  fact_revision INT UNSIGNED NOT NULL,    -- revision of the fact when it was proposed
  answer VARCHAR(8) NOT NULL,             -- positive, negative
  state VARCHAR(10) NOT NULL DEFAULT 'proposed',  -- proposed, ratified, rejected, revoked, withdrawn
  rationale_html MEDIUMTEXT NOT NULL,
  proposed_by INT UNSIGNED NOT NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,
  ai_generation_ms INT UNSIGNED NULL,
  ratified_by INT UNSIGNED NULL,          -- always a human
  ratified_at DATETIME NULL,
  ratified_revision INT UNSIGNED NULL,    -- revision of the fact that was ratified
  closed_by INT UNSIGNED NULL,            -- who rejected, revoked or withdrew it
  closed_at DATETIME NULL,
  closed_note VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL,
  KEY idx_answer_question (question_id, state),
  KEY idx_answer_fact (fact_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES open_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (proposed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feedback_reports (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind VARCHAR(10) NOT NULL,              -- bug, feature
  impact VARCHAR(10) NOT NULL DEFAULT 'normal',
  title VARCHAR(160) NOT NULL,
  body_text TEXT NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'new',  -- new, planned, in_progress, done, declined
  page VARCHAR(120) NULL,                 -- address of the page, without its query
  project_id INT UNSIGNED NULL,
  client_info VARCHAR(255) NULL,
  response_text TEXT NULL,
  responded_by INT UNSIGNED NULL,
  responded_at DATETIME NULL,
  author_unseen TINYINT(1) NOT NULL DEFAULT 0,
  admin_unseen TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  KEY idx_feedback_user (user_id, updated_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI work queue: the platform stores requests and results, and each user's own AI client does the computing.
CREATE TABLE IF NOT EXISTS ai_tasks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  kind VARCHAR(10) NOT NULL,              -- extract, ask, bib, derive
  status VARCHAR(10) NOT NULL DEFAULT 'pending',  -- pending, running, done, failed, cancelled
  source_type VARCHAR(12) NULL,           -- document, bib, message, comment, question, strategy, fact
  source_id INT UNSIGNED NULL,
  version_id INT UNSIGNED NULL,
  source_blob_id INT UNSIGNED NULL,       -- the PDF of a reference that an extraction reads
  conversation_id INT UNSIGNED NULL,      -- set when the task exposes a private conversation
  prompt_text TEXT NULL,
  requested_by INT UNSIGNED NULL,
  dedupe_key VARCHAR(60) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  not_before DATETIME NULL,
  lease_hash CHAR(64) NULL,
  lease_until DATETIME NULL,
  claimed_by INT UNSIGNED NULL,
  client_name VARCHAR(80) NULL,
  ai_model VARCHAR(120) NULL,
  ai_user_id INT UNSIGNED NULL,
  ai_generation_ms INT UNSIGNED NULL,
  summary_text TEXT NULL,
  error_text TEXT NULL,
  result_json TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  UNIQUE KEY uq_ai_task_dedupe (project_id, dedupe_key),
  KEY idx_ai_task_queue (status, kind, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_clients (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  ai_model VARCHAR(120) NULL,
  last_seen_at DATETIME NOT NULL,
  UNIQUE KEY uq_ai_client (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bib_suggestions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  task_id INT UNSIGNED NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'proposed',  -- proposed, accepted, rejected
  title VARCHAR(500) NOT NULL,
  authors VARCHAR(1000) NULL,
  year VARCHAR(4) NULL,
  venue VARCHAR(255) NULL,
  doi VARCHAR(200) NULL,
  arxiv VARCHAR(40) NULL,
  url VARCHAR(500) NULL,
  reason_text TEXT NOT NULL,
  ai_model VARCHAR(120) NOT NULL,
  ai_user_id INT UNSIGNED NULL,
  ai_generation_ms INT UNSIGNED NULL,
  bib_id INT UNSIGNED NULL,
  decided_by INT UNSIGNED NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  KEY idx_bib_suggestion (project_id, status),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES ai_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (bib_id) REFERENCES bib_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (ai_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
