# Personal Chat Sessions

## Problem

OpenObs chat currently behaves like the conversation is attached to the page
or resource that the user lands on after an agent action. That creates two UX
and security problems:

- A dashboard, investigation, or alert is often shared inside an org, but the
  conversation that created it is personal working context.
- A home-page conversation can disappear from the user's point of view when a
  tab changes or the agent navigates to the created resource.

The product model should make chat history durable and private by default.

## Model

Chat is a first-class personal object:

```text
User -> ChatSession -> ChatSessionContext -> Dashboard | Investigation | Alert
```

Rules:

- `chat_sessions` are scoped by `org_id` and `owner_user_id`.
- `chat_messages` and `chat_session_events` are reachable only through an
  authorized session owned by the current user.
- A resource may be linked to many personal sessions, but a resource never
  owns or exposes those sessions by default.
- Shared/team-visible chat can be added later with an explicit `visibility`
  field. The default and only v1 behavior is private.

## API Shape

`POST /api/chat`

- Without `sessionId`, creates a private session for the current user.
- With `sessionId`, continues only if the session belongs to the current user.
- Accepts optional `pageContext` as a prompt and context-link hint.
- Returns the durable `sessionId` in the SSE `done` event.

`GET /api/chat/sessions`

- Lists only the current user's sessions in the current org.
- Supports `limit`.
- Future filter: `resourceType/resourceId`.

`GET /api/chat/sessions/:id/messages`

- Returns messages and persisted step events only if the session belongs to
  the current user.

`GET /api/chat/:sessionId`

- Legacy route should be removed once the web client uses the canonical
  `/sessions/:id/messages` route everywhere.

## Resource Contexts

Add `chat_session_contexts`:

```text
id
session_id
org_id
owner_user_id
resource_type     dashboard | investigation | alert
resource_id
relation          created_from_chat | viewed_with_chat | referenced
created_at
```

The chat service records a context when:

- a page sends `pageContext.kind/id`
- the agent returns a navigation target for a created dashboard,
  investigation, or alert

This table is not an access-control grant. It is an index for "my chats about
this resource".

## Frontend UX

Home:

- Starting a chat creates a durable personal session as soon as the first
  message is sent.
- The returned `sessionId` is stored in the global chat context and can also
  be represented in the URL as `?chat=<id>` when useful.
- Home shows a "My conversations" list from `GET /api/chat/sessions`.

Resource pages:

- If the URL has `?chat=<id>`, load that session after ownership validation.
- If no chat id exists, the page may offer "New chat" and "Continue recent
  chat" from the current user's resource-linked sessions.
- Opening a shared dashboard never reveals another user's conversations.

Navigation:

- Agent-created resources should navigate with the session id preserved:
  `/dashboards/<id>?chat=<sessionId>`.
- The global chat context should not rely on tab-local state as the source of
  truth. Server state is canonical.

## Migration

1. Add nullable `owner_user_id` and default private metadata to chat sessions.
2. Backfill existing sessions conservatively:
   - sessions created by authenticated traffic should receive the stored user
     when available
   - otherwise they remain visible only to admins or are hidden from normal
     user lists until claimed by a migration path
3. Remove resource-owned chat loading from dashboards/investigations.
4. Remove the legacy `GET /api/chat/:sessionId` route after frontend cutover.

## Non-Goals

- Team-visible shared chat threads.
- Resource-level chat audit export.
- Cross-user handoff of active chat sessions.
