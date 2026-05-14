# Administration

Administration covers first-run setup, settings, users, teams, roles, service accounts, organizations, and audit logs.

## Setup wizard

On a new instance, Rounds redirects to **Setup** until the instance has required configuration and an administrator.

The wizard guides you through:

- welcome and readiness;
- administrator creation;
- LLM provider;
- connectors;
- notifications;
- finish.

After setup, users sign in through the configured authentication method.

## Settings

Open **Settings** for instance and personal configuration.

- **Connectors**: observability, runtime, code, incident, notification, and cloud connectors.
- **AI**: provider, model, and LLM credentials.
- **Notifications**: alert and approval delivery.
- **Account**: current user details.
- **Danger**: irreversible instance actions when permitted.

## Users, teams, and roles

Open **Admin** when your role allows it.

Admin tabs include:

- Users;
- Service accounts;
- Teams;
- Roles;
- Organizations for server admins;
- Audit log.

Use teams and roles to grant access by responsibility instead of sharing admin accounts.

## Service accounts

Use service accounts for automation, background agents, integrations, and API access. Treat generated tokens like secrets and rotate them when exposed.

## Audit log

Use the audit log to review sign-ins, permission changes, token activity, approvals, and other security-sensitive events.
