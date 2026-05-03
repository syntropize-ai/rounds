-- Consolidated Postgres schema for openobs.
-- Generated from the SQLite schema shape so both backends expose the same tables.

-- ============================================================================
-- Auth / RBAC
-- ============================================================================

CREATE TABLE IF NOT EXISTS org (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  address1      TEXT NULL,
  address2      TEXT NULL,
  city          TEXT NULL,
  state         TEXT NULL,
  zip_code      TEXT NULL,
  country       TEXT NULL,
  billing_email TEXT NULL,
  created       TEXT NOT NULL,
  updated       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_name ON org(name);

INSERT INTO org (id, name, created, updated)
VALUES ('org_main', 'Main Org', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS "user" (
  id                 TEXT PRIMARY KEY,
  version            INTEGER NOT NULL DEFAULT 0,
  email              TEXT NOT NULL,
  name               TEXT NOT NULL,
  login              TEXT NOT NULL,
  password           TEXT NULL,
  salt               TEXT NULL,
  rands              TEXT NULL,
  company            TEXT NULL,
  org_id             TEXT NOT NULL,
  is_admin           INTEGER NOT NULL DEFAULT 0,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  theme              TEXT NULL,
  help_flags1        INTEGER NOT NULL DEFAULT 0,
  is_disabled        INTEGER NOT NULL DEFAULT 0,
  is_service_account INTEGER NOT NULL DEFAULT 0,
  created            TEXT NOT NULL,
  updated            TEXT NOT NULL,
  last_seen_at       TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_email ON "user"(email);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_login ON "user"(login);
CREATE INDEX IF NOT EXISTS ix_user_org_id ON "user"(org_id);
CREATE INDEX IF NOT EXISTS ix_user_is_service_account ON "user"(is_service_account);

CREATE TABLE IF NOT EXISTS user_auth (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  auth_module          TEXT NOT NULL,
  auth_id              TEXT NOT NULL,
  created              TEXT NOT NULL,
  o_auth_access_token  TEXT NULL,
  o_auth_refresh_token TEXT NULL,
  o_auth_token_type    TEXT NULL,
  o_auth_expiry        INTEGER NULL,
  o_auth_id_token      TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_auth_module_authid ON user_auth(auth_module, auth_id);
CREATE INDEX IF NOT EXISTS ix_user_auth_user_id ON user_auth(user_id);

CREATE TABLE IF NOT EXISTS user_auth_token (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  auth_token      TEXT NOT NULL,
  prev_auth_token TEXT NOT NULL,
  user_agent      TEXT NOT NULL,
  client_ip       TEXT NOT NULL,
  auth_token_seen INTEGER NOT NULL DEFAULT 0,
  seen_at         TEXT NULL,
  rotated_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  revoked_at      TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_auth_token_authtoken ON user_auth_token(auth_token);
CREATE INDEX IF NOT EXISTS ix_user_auth_token_user_id ON user_auth_token(user_id);
CREATE INDEX IF NOT EXISTS ix_user_auth_token_revoked_at ON user_auth_token(revoked_at);

CREATE TABLE IF NOT EXISTS org_user (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role    TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_user_org_user ON org_user(org_id, user_id);
CREATE INDEX IF NOT EXISTS ix_org_user_user_id ON org_user(user_id);

CREATE TABLE IF NOT EXISTS team (
  id       TEXT PRIMARY KEY,
  org_id   TEXT NOT NULL,
  name     TEXT NOT NULL,
  email    TEXT NULL,
  external INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL,
  updated  TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_org_name ON team(org_id, name);
CREATE INDEX IF NOT EXISTS ix_team_org_id ON team(org_id);

CREATE TABLE IF NOT EXISTS team_member (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  external   INTEGER NOT NULL DEFAULT 0,
  permission INTEGER NOT NULL DEFAULT 0,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_member_team_user ON team_member(team_id, user_id);
CREATE INDEX IF NOT EXISTS ix_team_member_org_id ON team_member(org_id);
CREATE INDEX IF NOT EXISTS ix_team_member_user_id ON team_member(user_id);

CREATE TABLE IF NOT EXISTS api_key (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  key                TEXT NOT NULL,
  role               TEXT NOT NULL,
  created            TEXT NOT NULL,
  updated            TEXT NOT NULL,
  last_used_at       TEXT NULL,
  expires            TEXT NULL,
  service_account_id TEXT NULL,
  owner_user_id      TEXT NULL,
  is_revoked         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id)             REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (service_account_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id)      REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_key_key ON api_key(key);
CREATE INDEX IF NOT EXISTS ix_api_key_org_id ON api_key(org_id);
CREATE INDEX IF NOT EXISTS ix_api_key_owner_user_id ON api_key(owner_user_id);
CREATE INDEX IF NOT EXISTS ix_api_key_service_account_id ON api_key(service_account_id);

CREATE TABLE IF NOT EXISTS role (
  id           TEXT PRIMARY KEY,
  version      INTEGER NOT NULL DEFAULT 0,
  org_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  uid          TEXT NOT NULL,
  display_name TEXT NULL,
  description  TEXT NULL,
  group_name   TEXT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_role_org_name ON role(org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_org_uid ON role(org_id, uid);

CREATE TABLE IF NOT EXISTS permission (
  id         TEXT PRIMARY KEY,
  role_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  attribute  TEXT NOT NULL,
  identifier TEXT NOT NULL,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_permission_role_id ON permission(role_id);
CREATE INDEX IF NOT EXISTS ix_permission_action ON permission(action);
CREATE INDEX IF NOT EXISTS ix_permission_kind_identifier ON permission(kind, identifier);

CREATE TABLE IF NOT EXISTS builtin_role (
  id      TEXT PRIMARY KEY,
  role    TEXT NOT NULL,
  role_id TEXT NOT NULL,
  org_id  TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_builtin_role_role_orgid ON builtin_role(role, org_id, role_id);

CREATE TABLE IF NOT EXISTS user_role (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_role ON user_role(org_id, user_id, role_id);
CREATE INDEX IF NOT EXISTS ix_user_role_user_id ON user_role(user_id);

CREATE TABLE IF NOT EXISTS team_role (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL,
  team_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_role ON team_role(org_id, team_id, role_id);
CREATE INDEX IF NOT EXISTS ix_team_role_team_id ON team_role(team_id);

CREATE TABLE IF NOT EXISTS preferences (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  user_id            TEXT NULL,
  team_id            TEXT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  home_dashboard_uid TEXT NULL,
  timezone           TEXT NULL,
  week_start         TEXT NULL,
  theme              TEXT NULL,
  locale             TEXT NULL,
  json_data          TEXT NULL,
  created            TEXT NOT NULL,
  updated            TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_preferences_org_user_team
  ON preferences(org_id, COALESCE(user_id, ''), COALESCE(team_id, ''));

CREATE TABLE IF NOT EXISTS quota (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NULL,
  user_id   TEXT NULL,
  target    TEXT NOT NULL,
  limit_val INTEGER NOT NULL,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_quota_org_target  ON quota(org_id, target)  WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_quota_user_target ON quota(user_id, target) WHERE org_id IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT NULL,
  actor_name  TEXT NULL,
  org_id      TEXT NULL,
  target_type TEXT NULL,
  target_id   TEXT NULL,
  target_name TEXT NULL,
  outcome     TEXT NOT NULL,
  metadata    TEXT NULL,
  ip          TEXT NULL,
  user_agent  TEXT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS ix_audit_log_action    ON audit_log(action);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor_id  ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_target_id ON audit_log(target_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_org_id    ON audit_log(org_id);

-- ============================================================================
-- Folders & ACL
-- ============================================================================

CREATE TABLE IF NOT EXISTS folder (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NULL,
  parent_uid  TEXT NULL,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL,
  created_by  TEXT NULL,
  updated_by  TEXT NULL,
  FOREIGN KEY (org_id)     REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_folder_org_uid    ON folder(org_id, uid);
CREATE INDEX        IF NOT EXISTS ix_folder_parent_uid ON folder(org_id, parent_uid);

CREATE TABLE IF NOT EXISTS dashboard_acl (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  dashboard_id TEXT NULL,
  folder_id    TEXT NULL,
  user_id      TEXT NULL,
  team_id      TEXT NULL,
  role         TEXT NULL,
  permission   INTEGER NOT NULL,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_dashboard_acl_dashboard_id ON dashboard_acl(dashboard_id);
CREATE INDEX IF NOT EXISTS ix_dashboard_acl_folder_id    ON dashboard_acl(folder_id);

-- Legacy folders table (separate from `folder` above) — kept because some
-- v1 paths still write to it. New code targets `folder`.
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================================
-- Instance config (LLM / datasources / notifications / KV)
-- ============================================================================

CREATE TABLE IF NOT EXISTS instance_llm_config (
  id             TEXT PRIMARY KEY CHECK (id = 'singleton'),
  provider       TEXT NOT NULL,
  api_key        TEXT NULL,
  model          TEXT NOT NULL,
  base_url       TEXT NULL,
  auth_type      TEXT NULL,
  region         TEXT NULL,
  api_key_helper TEXT NULL,
  api_format     TEXT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NULL
);

CREATE TABLE IF NOT EXISTS instance_datasources (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  environment TEXT NULL,
  cluster     TEXT NULL,
  label       TEXT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  api_key     TEXT NULL,
  username    TEXT NULL,
  password    TEXT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_instance_datasources_org_name ON instance_datasources(org_id, name);
CREATE INDEX        IF NOT EXISTS ix_instance_datasources_org_id   ON instance_datasources(org_id);
CREATE INDEX        IF NOT EXISTS ix_instance_datasources_type     ON instance_datasources(type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_instance_datasources_default
  ON instance_datasources(org_id, type)
  WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS notification_channels (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_notification_channels_org_id ON notification_channels(org_id);
CREATE INDEX IF NOT EXISTS ix_notification_channels_type   ON notification_channels(type);

CREATE TABLE IF NOT EXISTS instance_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- KV bag for internal markers (auth-bootstrap flag, etc.). Distinct from
-- `instance_settings` (user-visible) by the `_` prefix convention.
CREATE TABLE IF NOT EXISTS _runtime_settings (
  id      TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- ============================================================================
-- Investigations
-- ============================================================================

CREATE TABLE IF NOT EXISTS investigations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL DEFAULT 'org_main',
  tenant_id         TEXT NOT NULL DEFAULT '',
  session_id        TEXT,
  user_id           TEXT,
  intent            TEXT NOT NULL,
  structured_intent TEXT,
  plan              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  hypotheses        TEXT NOT NULL DEFAULT '[]',
  actions           TEXT NOT NULL DEFAULT '[]',
  evidence          TEXT NOT NULL DEFAULT '[]',
  symptoms          TEXT NOT NULL DEFAULT '[]',
  workspace_id      TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_investigations_org_id ON investigations(org_id);

CREATE TABLE IF NOT EXISTS investigation_follow_ups (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investigation_feedback (
  id                   TEXT PRIMARY KEY,
  investigation_id     TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  helpful              INTEGER NOT NULL,
  comment              TEXT,
  root_cause_verdict   TEXT,
  hypothesis_feedbacks TEXT,
  action_feedbacks     TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investigation_conclusions (
  investigation_id TEXT PRIMARY KEY REFERENCES investigations(id) ON DELETE CASCADE,
  conclusion       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investigation_reports (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL DEFAULT 'org_main',
  dashboard_id TEXT NOT NULL,
  goal         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  sections     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_investigation_reports_org_id ON investigation_reports(org_id);

CREATE TABLE IF NOT EXISTS share_links (
  token            TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  created_by       TEXT NOT NULL,
  permission       TEXT NOT NULL DEFAULT 'view_only',
  expires_at       TEXT,
  created_at       TEXT NOT NULL
);

-- ============================================================================
-- Incidents / feed / approvals / post-mortems
-- ============================================================================

CREATE TABLE IF NOT EXISTS incidents (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL DEFAULT 'org_main',
  tenant_id          TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL,
  severity           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  service_ids        TEXT NOT NULL DEFAULT '[]',
  investigation_ids  TEXT NOT NULL DEFAULT '[]',
  timeline           TEXT NOT NULL DEFAULT '[]',
  assignee           TEXT,
  workspace_id       TEXT,
  archived           INTEGER NOT NULL DEFAULT 0,
  resolved_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_incidents_org_id ON incidents(org_id);

CREATE TABLE IF NOT EXISTS feed_items (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL DEFAULT 'org_main',
  tenant_id           TEXT NOT NULL DEFAULT '',
  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  severity            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unread',
  feedback            TEXT,
  feedback_comment    TEXT,
  hypothesis_feedback TEXT,
  action_feedback     TEXT,
  investigation_id    TEXT,
  followed_up         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_feed_items_org_id ON feed_items(org_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL DEFAULT 'org_main',
  action            TEXT NOT NULL,
  context           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  expires_at        TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,
  resolved_by_roles TEXT,
  ops_connector_id  TEXT,
  target_namespace  TEXT,
  requester_team_id TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_approvals_org_id    ON approvals(org_id);
CREATE INDEX IF NOT EXISTS ix_approvals_connector ON approvals(ops_connector_id);
CREATE INDEX IF NOT EXISTS ix_approvals_namespace ON approvals(ops_connector_id, target_namespace);
CREATE INDEX IF NOT EXISTS ix_approvals_team      ON approvals(requester_team_id);

CREATE TABLE IF NOT EXISTS post_mortems (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL DEFAULT 'org_main',
  incident_id     TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  impact          TEXT NOT NULL,
  timeline        TEXT NOT NULL,
  root_cause      TEXT NOT NULL,
  actions_taken   TEXT NOT NULL,
  lessons_learned TEXT NOT NULL,
  action_items    TEXT NOT NULL,
  generated_at    TEXT NOT NULL,
  generated_by    TEXT NOT NULL DEFAULT 'llm'
);

CREATE INDEX IF NOT EXISTS ix_post_mortems_org_id ON post_mortems(org_id);

-- ============================================================================
-- Dashboards / chat
-- ============================================================================

CREATE TABLE IF NOT EXISTS dashboards (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL DEFAULT 'org_main',
  type                 TEXT NOT NULL DEFAULT 'dashboard',
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'generating',
  panels               TEXT NOT NULL DEFAULT '[]',
  variables            TEXT NOT NULL DEFAULT '[]',
  refresh_interval_sec INTEGER NOT NULL DEFAULT 30,
  datasource_ids       TEXT NOT NULL DEFAULT '[]',
  use_existing_metrics INTEGER NOT NULL DEFAULT 1,
  folder               TEXT,
  folder_uid           TEXT NULL,
  workspace_id         TEXT,
  version              INTEGER,
  publish_status       TEXT,
  error                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_dashboards_org_id     ON dashboards(org_id);
CREATE INDEX IF NOT EXISTS ix_dashboards_folder_uid ON dashboards(org_id, folder_uid);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL DEFAULT 'org_main',
  owner_user_id   TEXT,
  title           TEXT NOT NULL DEFAULT '',
  context_summary TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_chat_sessions_org_id ON chat_sessions(org_id);
CREATE INDEX IF NOT EXISTS ix_chat_sessions_owner ON chat_sessions(org_id, owner_user_id);

CREATE TABLE IF NOT EXISTS chat_session_contexts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  relation        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_chat_session_contexts_session ON chat_session_contexts(session_id);
CREATE INDEX IF NOT EXISTS ix_chat_session_contexts_owner_resource ON chat_session_contexts(org_id, owner_user_id, resource_type, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_session_contexts_unique ON chat_session_contexts(session_id, resource_type, resource_id, relation);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'org_main',
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  actions    TEXT,
  timestamp  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_chat_messages_org_id ON chat_messages(org_id);

CREATE TABLE IF NOT EXISTS chat_session_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'org_main',
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  timestamp  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_session_events_session_idx ON chat_session_events(session_id);
CREATE INDEX IF NOT EXISTS chat_session_events_seq_idx     ON chat_session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_chat_session_events_org_id   ON chat_session_events(org_id);

CREATE TABLE IF NOT EXISTS asset_versions (
  id          TEXT PRIMARY KEY,
  asset_type  TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  diff        TEXT,
  edited_by   TEXT NOT NULL,
  edit_source TEXT NOT NULL,
  message     TEXT,
  created_at  TEXT NOT NULL
);

-- ============================================================================
-- Alerting & notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_rules (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL DEFAULT 'org_main',
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  original_prompt         TEXT,
  condition               TEXT NOT NULL,
  evaluation_interval_sec INTEGER NOT NULL DEFAULT 60,
  severity                TEXT NOT NULL,
  labels                  TEXT,
  state                   TEXT NOT NULL DEFAULT 'normal',
  state_changed_at        TEXT NOT NULL,
  pending_since           TEXT,
  notification_policy_id  TEXT,
  investigation_id        TEXT,
  workspace_id            TEXT,
  folder_uid              TEXT NULL,
  created_by              TEXT NOT NULL,
  last_evaluated_at       TEXT,
  last_fired_at           TEXT,
  fire_count              INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_alert_rules_org_id     ON alert_rules(org_id);
CREATE INDEX IF NOT EXISTS ix_alert_rules_folder_uid ON alert_rules(org_id, folder_uid);

CREATE TABLE IF NOT EXISTS alert_history (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL DEFAULT 'org_main',
  rule_id   TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  threshold  INTEGER NOT NULL DEFAULT 0,
  timestamp  TEXT NOT NULL,
  labels     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_alert_history_org_id ON alert_history(org_id);

CREATE TABLE IF NOT EXISTS alert_silences (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'org_main',
  matchers   TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  comment    TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_alert_silences_org_id ON alert_silences(org_id);

CREATE TABLE IF NOT EXISTS notification_policies (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  matchers            TEXT NOT NULL,
  channels            TEXT NOT NULL,
  group_by            TEXT,
  group_wait_sec      INTEGER,
  group_interval_sec  INTEGER,
  repeat_interval_sec INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_points (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  integrations TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_policy_tree (
  id         TEXT PRIMARY KEY DEFAULT 'root',
  tree       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mute_timings (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  time_intervals TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- T3: per-(fingerprint, contactPoint, groupKey) dispatch tracking for
-- group/repeat windows on alert notifications.
CREATE TABLE IF NOT EXISTS notification_dispatch (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  contact_point_id TEXT NOT NULL,
  group_key        TEXT NOT NULL,
  last_sent_at     TEXT NOT NULL,
  sent_count       INTEGER NOT NULL,
  UNIQUE (fingerprint, contact_point_id, group_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_dispatch_lookup
  ON notification_dispatch (org_id, fingerprint, contact_point_id);

-- ============================================================================
-- Ops connectors (Kubernetes etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ops_connectors (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type = 'kubernetes'),
  name                    TEXT NOT NULL,
  environment             TEXT NULL,
  config_json             TEXT NOT NULL,
  secret_ref              TEXT NULL,
  encrypted_secret        TEXT NULL,
  allowed_namespaces_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json       TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at         TEXT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ops_connectors_org_name ON ops_connectors(org_id, name);
CREATE INDEX        IF NOT EXISTS ix_ops_connectors_org_id   ON ops_connectors(org_id);
CREATE INDEX        IF NOT EXISTS ix_ops_connectors_org_type ON ops_connectors(org_id, type);

-- ============================================================================
-- Change sources and events (GitHub deployments, releases, etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS change_sources (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type = 'github'),
  name             TEXT NOT NULL,
  owner            TEXT NULL,
  repo             TEXT NULL,
  events_json      TEXT NOT NULL DEFAULT '[]',
  encrypted_secret TEXT NULL,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_event_at    TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_change_sources_org_name ON change_sources(org_id, name);
CREATE INDEX        IF NOT EXISTS ix_change_sources_org_id   ON change_sources(org_id);
CREATE INDEX        IF NOT EXISTS ix_change_sources_org_type ON change_sources(org_id, type);

CREATE TABLE IF NOT EXISTS change_events (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  service_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  author       TEXT NOT NULL,
  description  TEXT NOT NULL,
  diff         TEXT NULL,
  version      TEXT NULL,
  payload_json TEXT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES change_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_change_events_org_time
  ON change_events(org_id, timestamp);
CREATE INDEX IF NOT EXISTS ix_change_events_source_time
  ON change_events(source_id, timestamp);
CREATE INDEX IF NOT EXISTS ix_change_events_service_time
  ON change_events(org_id, service_id, timestamp);

-- ============================================================================
-- Remediation plans (Phase 3 of docs/design/auto-remediation.md)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remediation_plan (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  investigation_id    TEXT NOT NULL,
  rescue_for_plan_id  TEXT,
  summary             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending_approval',
  auto_edit           BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  resolved_at         TEXT,
  resolved_by         TEXT
);

CREATE INDEX IF NOT EXISTS ix_remediation_plan_org_status
  ON remediation_plan(org_id, status);
CREATE INDEX IF NOT EXISTS ix_remediation_plan_investigation
  ON remediation_plan(investigation_id);
CREATE INDEX IF NOT EXISTS ix_remediation_plan_rescue_for
  ON remediation_plan(rescue_for_plan_id);

CREATE TABLE IF NOT EXISTS remediation_plan_step (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  command_text        TEXT NOT NULL,
  params_json         TEXT NOT NULL DEFAULT '{}',
  dry_run_text        TEXT,
  risk_note           TEXT,
  continue_on_error   BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'pending',
  approval_request_id TEXT,
  executed_at         TEXT,
  output_text         TEXT,
  error_text          TEXT,
  UNIQUE(plan_id, ordinal)
);

CREATE INDEX IF NOT EXISTS ix_remediation_plan_step_plan
  ON remediation_plan_step(plan_id);
