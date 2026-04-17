-- Migration 003: user_auth
--
-- Grafana ref: pkg/services/sqlstore/migrations/user_auth_mig.go
-- See docs/auth-perm-design/01-database-schema.md §user_auth
--
-- Links one user to N external identities (oauth_github, oauth_google,
-- oauth_generic, saml, ldap).
--
-- [openobs-deviation] Primary key is TEXT (uuid).
-- [openobs-deviation] Timestamps are TEXT ISO-8601; o_auth_expiry stays INTEGER
--   epoch millis because Grafana exposes it as an int64 field in its API
--   contract (see pkg/services/login/model.go::UserAuth).

CREATE TABLE IF NOT EXISTS user_auth (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  auth_module           TEXT NOT NULL,
  auth_id               TEXT NOT NULL,
  created               TEXT NOT NULL,
  o_auth_access_token   TEXT NULL,
  o_auth_refresh_token  TEXT NULL,
  o_auth_token_type     TEXT NULL,
  o_auth_expiry         INTEGER NULL,
  o_auth_id_token       TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_auth_module_authid ON user_auth(auth_module, auth_id);
CREATE INDEX IF NOT EXISTS ix_user_auth_user_id ON user_auth(user_id);
