# Public Batch Register (Regex-Generated Accounts) Design

**Date:** 2026-03-03

## Goal

Add an admin-only API on the Cloudflare Worker to create multiple accounts in one request by generating email local-parts from server-configured regex-like rules.

Input: `n`.

Output: up to `n` created accounts. If fewer than `n` are created, return the successful accounts plus a list of failures with reasons.

## Non-Goals

- Do not accept regex rules from clients.
- Do not require JWT login for this API.
- Do not respect end-user registration switches (e.g. `register`, reg-key, Turnstile). This is an admin automation endpoint.

## Current System Context (Relevant)

- Worker entry: requests to `/api/*` are rewritten to strip `/api` and forwarded to the Hono app.
- Auth middleware:
  - `/public/*` uses a "Public Token" in `Authorization` header, compared against KV key `PUBLIC_KEY`.
  - `/register` and `/login` are excluded from auth.

## Proposed API

### Endpoint

- External: `POST /api/public/batchRegister`
- Internal Hono route: `POST /public/batchRegister`

### Auth

- Use existing `/public/*` auth: header `Authorization: <PUBLIC_KEY>`.
- Token provisioning remains via existing `POST /api/public/genToken`.

### Request

```json
{ "n": 20 }
```

- `n` must be an integer > 0.
- `n` is capped by `BATCH_REGISTER_MAX_N` (default 50).

### Response

Using existing `result.ok(data)` envelope.

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "requested": 20,
    "created": 17,
    "accounts": [
      { "email": "u123abc@example.com", "password": "..." }
    ],
    "failures": [
      {
        "rule": "[a-z]{8}",
        "email": "abcd...@example.com",
        "reason_code": "already_exists",
        "message": "Account already exists"
      },
      {
        "rule": "(dev|test)[a-z0-9]{6}",
        "reason_code": "exhausted_attempts",
        "message": "Unable to create enough unique accounts within attempt limits"
      }
    ]
  }
}
```

## Rule Source (Environment Variables)

- `BATCH_REGISTER_REGEX_RULES` (required)
  - JSON array string of rule patterns.
  - Example: `["[a-z]{8}","(dev|test)[a-z0-9]{6}","u[0-9]{6}"]`

Optional tuning:

- `BATCH_REGISTER_MAX_N` (default `50`)
- `BATCH_REGISTER_MAX_ATTEMPTS` (default `n * 20`)
- `BATCH_REGISTER_PASSWORD_LEN` (default `12`)
- `BATCH_REGISTER_PICK_DOMAIN` (default `random`, alternative `first`)

## Email Generation Strategy

1. Load rules from `BATCH_REGISTER_REGEX_RULES`.
2. Repeat attempts until `created === n` or `attempts === maxAttempts`.
3. Per attempt:
   - Randomly pick a rule from the list.
   - Use a simplified regex generator to produce a local-part (prefix).
   - Pick domain:
     - Parse `c.env.domain` similarly to `settingService.query` behavior.
     - Choose first or random domain depending on config.
   - Compose email: `${prefix}@${domain}`.
   - Validate and enforce existing constraints (same as register/add-account behavior):
     - `verifyUtils.isEmail(email)`
     - `minEmailPrefix`, `emailPrefixFilter`
     - local-part length <= 64
     - domain must be allowed by `c.env.domain`
     - must not already exist (including deleted).
   - If valid, create user+account and return generated password.

### Simplified Regex Generator (Supported Subset)

- Literals
- Concatenation
- Character classes: `[abc]`, ranges like `[a-z0-9]`
- Alternation groups: `(foo|bar|baz)`
- Quantifiers:
  - `{m,n}`
  - `?` (0..1)
  - `+` (1..MAX_REPEAT)
  - `*` (0..MAX_REPEAT)

Hard limits:

- `MAX_REPEAT` (implementation constant, e.g. 16)
- `MAX_OUTPUT_LEN` (implementation constant, e.g. 64 for local-part)

Unsupported constructs should cause `reason_code=unsupported_regex`.

## Failure Reasons

Failures are collected per invalid/failed attempt and summarized.

`reason_code` values:

- `invalid_env_rules`: missing/invalid JSON/empty rules
- `unsupported_regex`: rule contains unsupported syntax
- `generator_failed`: could not generate within constraints
- `invalid_email`: generated email fails validation
- `domain_not_allowed`
- `min_prefix_len`
- `prefix_filtered`
- `prefix_too_long`
- `already_exists`
- `deleted_not_reusable`
- `db_constraint`
- `exhausted_attempts`

## Data Model / DB Notes

- `user.email` and `account.email` have unique indexes with NOCASE collation (`idx_user_email_nocase`, `idx_account_email_nocase`).
- Implementation should treat collisions as expected and return `db_constraint` or `already_exists`.

## Security

- Endpoint is protected by the existing `/public/*` token gate.
- No client-controlled regex input.
- Attempt limits prevent compute abuse.

## Testing

- Add Vitest tests under `mail-worker/test`:
  - success creating N accounts with deterministic RNG
  - returns fewer than N with `exhausted_attempts` when rules are too narrow
  - rejects invalid env rules
  - validates prefix filter / min prefix length integration

