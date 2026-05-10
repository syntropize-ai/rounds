# Postgres repositories

This directory holds the full Postgres repository backend. The gateway enables
it when `DATABASE_URL` starts with `postgres://` or `postgresql://`; otherwise it
uses the SQLite backend.

## Scope

Postgres now has siblings for the same repository bundle that SQLite exposes:
auth, RBAC, instance settings, connectors, dashboards, investigations, alerts,
notifications, chat, feed, approvals, shares, and related domain data. The
schema is applied by `schema-applier.ts` from `schema.sql` during startup.

Keep database-specific logic inside this directory and the persistence factory.
API routes and services should depend on repository interfaces plus the
`QueryClient` raw query boundary, not on a concrete database client.
