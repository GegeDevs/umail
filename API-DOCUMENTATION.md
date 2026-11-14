# UMail API Documentation

REST API v1 for automating a self-hosted UMail instance. All endpoints in this document use JSON over HTTP and require an API key.

Base URL in local development:

```text
http://localhost:3000
```

## Authentication

Create a key in the web UI at `#/api-access` (requires permission `admin:manage_api`). The key is shown once. Send it as a bearer token:

```http
Authorization: Bearer umail_xxxxxxxxxxxxxxxxxxxxxxxx
```

Every key carries its own permission set, rate limit (requests per minute), and optional expiry. Revoking a key invalidates it immediately.

### Permissions

| Permission | Grants access to |
| --- | --- |
| `api:mail:read` | `/messages`, `/threads`, `/labels`, `/search` |
| `api:mail:send` | `POST /messages/send` |
| `api:mail:modify` | `POST /messages/actions` |
| `api:accounts:read` | `GET /accounts` |

Requesting an endpoint without its permission returns `403`.

### Rate limits

Limits are per key and per one-minute window (default 60/min, configurable up to 600/min).

Every response includes:

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
```

Requests over the limit return `429`.

## Errors

Errors return a JSON body:

```json
{ "error": "Missing permission: api:mail:read" }
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid or missing input |
| `401` | Missing, invalid, revoked, or expired API key |
| `403` | Key lacks the required permission |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `502` | Gmail request failed |

## Endpoints

### `GET /api/v1/accounts`

List connected Google accounts with unread inbox counts.

Permission: `api:accounts:read`

```bash
curl -s http://localhost:3000/api/v1/accounts \
  -H "Authorization: Bearer $UMAIL_KEY"
```

```json
{
  "results": [
    {
      "id": 1,
      "email": "ada@example.com",
      "display_name": "Ada",
      "card_color": "#2563eb",
      "status": "healthy",
      "unread": 26
    }
  ]
}
```

`status` is `healthy`, `error`, or `reauth_required`. `unread` counts synced inbox messages that are unread and not in trash or spam.

### `GET /api/v1/messages`

List cached messages in a mailbox, newest first.

Permission: `api:mail:read`

| Query | Default | Description |
| --- | --- | --- |
| `box` | `inbox` | `inbox`, `starred`, `important`, `sent`, `drafts`, `archive`, `spam`, `trash` |
| `accountId` | all | Restrict to one account |
| `limit` | `30` | 1–100 |
| `cursor` | – | `nextCursor` from the previous page |

```bash
curl -s "http://localhost:3000/api/v1/messages?box=inbox&limit=30" \
  -H "Authorization: Bearer $UMAIL_KEY"
```

```json
{
  "box": "inbox",
  "results": [
    {
      "id": 42,
      "account_id": 1,
      "gmail_message_id": "18f...",
      "gmail_thread_id": "18f...",
      "internal_date": 1731400000000,
      "from_name": "Bob",
      "from_email": "bob@example.com",
      "to_json": "[{\"email\":\"ada@example.com\"}]",
      "subject": "Hello",
      "snippet": "Quick update on the deploy...",
      "label_ids": "[\"INBOX\",\"UNREAD\"]",
      "is_unread": 1,
      "is_starred": 0,
      "is_important": 0,
      "has_attachment": 0,
      "account_name": "Ada",
      "card_color": "#2563eb"
    }
  ],
  "nextCursor": "1731400000000_42"
}
```

`nextCursor` is `null` on the last page. `internal_date` is Unix time in milliseconds. `to_json` and `label_ids` are JSON-encoded strings.

### `GET /api/v1/threads/:accountId/:threadId`

Read a cached thread and its messages in chronological order.

Permission: `api:mail:read`

```bash
curl -s "http://localhost:3000/api/v1/threads/1/18f..." \
  -H "Authorization: Bearer $UMAIL_KEY"
```

```json
{
  "thread": {
    "account_id": 1,
    "gmail_thread_id": "18f...",
    "messages": [
      {
        "id": 42,
        "account_id": 1,
        "gmail_message_id": "18f...",
        "gmail_thread_id": "18f...",
        "internal_date": 1731400000000,
        "from_name": "Bob",
        "from_email": "bob@example.com",
        "to_json": "[{\"email\":\"ada@example.com\"}]",
        "cc_json": "[]",
        "subject": "Hello",
        "snippet": "Quick update...",
        "label_ids": "[\"INBOX\"]",
        "is_unread": 0,
        "is_starred": 0,
        "is_important": 0,
        "has_attachment": 0
      }
    ]
  }
}
```

Message bodies are not returned by this endpoint; use the web UI reader or Gmail for full HTML.

### `GET /api/v1/labels`

List user labels, grouped by name across accounts.

Permission: `api:mail:read`

```bash
curl -s http://localhost:3000/api/v1/labels \
  -H "Authorization: Bearer $UMAIL_KEY"
```

```json
{
  "results": [
    {
      "name": "Work",
      "total": 12,
      "unread": 3,
      "accounts": [{ "account_id": 1, "gmail_label_id": "Label_12" }]
    }
  ]
}
```

### `GET /api/v1/search`

Search the local cache. This is not a Gmail fan-out; it matches subject, snippet, sender name, and sender email with `LIKE`.

Permission: `api:mail:read`

| Query | Default | Description |
| --- | --- | --- |
| `q` | – | Required search text |
| `accountId` | all | Restrict to one account |
| `limit` | `30` | 1–100 |

```bash
curl -s "http://localhost:3000/api/v1/search?q=deploy" \
  -H "Authorization: Bearer $UMAIL_KEY"
```

```json
{
  "query": "deploy",
  "results": [],
  "total": 0,
  "cached": true
}
```

### `POST /api/v1/messages/actions`

Apply an action to one or more messages. Actions are sent to Gmail and the local cache is updated.

Permission: `api:mail:modify`

| Action | Effect |
| --- | --- |
| `read` / `unread` | Toggle `UNREAD` |
| `star` / `unstar` | Toggle `STARRED` |
| `archive` | Remove `INBOX` |
| `inbox` | Add `INBOX` |
| `trash` / `untrash` | Toggle `TRASH` |
| `spam` / `not_spam` | Toggle `SPAM` |
| `apply_label` | Add `labelId` (required) |
| `remove_label` | Remove `labelId` (required) |

```bash
curl -s -X POST http://localhost:3000/api/v1/messages/actions \
  -H "Authorization: Bearer $UMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"accountId":1,"messageIds":["18f..."],"action":"archive"}'
```

```json
{ "updated": 1 }
```

Add a label:

```bash
curl -s -X POST http://localhost:3000/api/v1/messages/actions \
  -H "Authorization: Bearer $UMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"accountId":1,"messageIds":["18f..."],"action":"apply_label","labelId":"Label_12"}'
```

### `POST /api/v1/messages/send`

Send an email through a connected account.

Permission: `api:mail:send`

| Field | Required | Description |
| --- | --- | --- |
| `accountId` | yes | Sending account |
| `to` | * | Recipients; string or array |
| `cc` | * | CC recipients |
| `bcc` | * | BCC recipients |
| `subject` | no | Subject line |
| `body` | no | Plain-text body |
| `inReplyTo` | no | `Message-ID` being replied to |
| `references` | no | References header |
| `threadId` | no | Gmail thread to append to |
| `draftId` | no | Local draft to discard after sending |
| `attachments` | no | Array of `{ "name", "type", "data" }` where `data` is base64 |

\* At least one recipient across `to`, `cc`, or `bcc` is required.

```bash
curl -s -X POST http://localhost:3000/api/v1/messages/send \
  -H "Authorization: Bearer $UMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": 1,
    "to": "bob@example.com",
    "subject": "Deploy finished",
    "body": "Everything is green."
  }'
```

```json
{
  "ok": true,
  "messageId": "18f...",
  "threadId": "18f..."
}
```

## Notes and limits

- Read endpoints serve the local SQLite cache populated by sync (default window: 90 days, up to 1,000 messages per account). They do not call Gmail.
- `POST /messages/actions` and `POST /messages/send` do call Gmail and may return `502` with the upstream message.
- API keys are managed through the session-authenticated UI/API (`/api/api-keys`), not with a bearer key.
- `/api/v1/*` is exempt from CSRF checks; authentication is the bearer key.
- Message bodies, attachments download, and label CRUD are not exposed in v1 yet.
