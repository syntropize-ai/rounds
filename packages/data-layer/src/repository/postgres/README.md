# Postgres repositories

This directory holds Postgres-backed repository implementations. The gateway
selects the Postgres branch when `DATABASE_URL` starts with `postgres://` or
`postgresql://`; otherwise it defaults to the SQLite branch (see
`packages/api-gateway/src/server.ts` `buildPostgresRepositories` /
`buildSqliteRepositories`).

## Scope

The W2 instance-config stores (`InstanceConfigRepository`,
`DatasourceRepository`, `NotificationChannelRepository`) have Postgres
siblings here alongside the original SQLite implementations. These tables are
created by `migrations/001_instance_settings.sql`, ported from the SQLite
migrations `018_runtime_settings.sql` and `019_instance_settings.sql`.

The W6 stores — `DashboardRepository`, `InvestigationRepository`,
`AlertRuleRepository`, and friends — remain **SQLite-only** for this sprint.
Their interfaces (`@agentic-obs/common/repositories/dashboard|investigation|alert-rule`)
are owned by the Wave 6 teams and adding Postgres implementations here would
create a merge hazard with parallel work. Operators who set `DATABASE_URL` to
a Postgres connection string will get the W2 repos on Postgres, but the W6
repos on the same `DATABASE_URL` are a follow-up.
