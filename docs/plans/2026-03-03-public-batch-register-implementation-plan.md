# Public Batch Register Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `POST /api/public/batchRegister` to create up to `n` accounts per request by generating email local-parts from server-configured simplified-regex rules, returning partial success plus per-failure reasons.

**Architecture:** Implement a pure core function (`batchRegisterImpl`) that depends on injectable RNG + storage callbacks, unit-test it with stubs; then wire it into a new Hono route under `/public/*` (Public Token auth). Implement a small simplified-regex generator in `utils/regex-gen.js`.

**Tech Stack:** Cloudflare Workers, Hono, D1 (Drizzle ORM already used), KV, Vitest.

---

### Task 1: Add Unit Test Scaffold For Regex Generator

**Files:**
- Create: `mail-worker/test/regex-gen.spec.js`

**Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { generateFromRule, mulberry32 } from '../src/utils/regex-gen';

describe('regex-gen', () => {
  it('generates from alternation + charclass + quantifier', () => {
    const rng = mulberry32(123);
    const s = generateFromRule('(dev|test)[a-z0-9]{4}', rng, {
      maxRepeat: 16,
      maxOutputLen: 64,
    });

    expect(s.length).toBe(3 + 4); // dev/test + 4
    expect(['dev', 'test']).toContain(s.slice(0, 4));
    expect(s.slice(-4)).toMatch(/^[a-z0-9]{4}$/);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd mail-worker && pnpm exec vitest run test/regex-gen.spec.js
```

Expected: FAIL because `../src/utils/regex-gen` does not exist.

**Step 3: Commit**

```bash
git add mail-worker/test/regex-gen.spec.js
git commit -m "test: add regex generator spec"
```

---

### Task 2: Implement Simplified Regex Generator

**Files:**
- Create: `mail-worker/src/utils/regex-gen.js`

**Step 1: Write minimal implementation**

Implement:

- `mulberry32(seed)` returning `() => number` in [0, 1)
- `generateFromRule(rule, rng, { maxRepeat, maxOutputLen })`

Supported subset:
- literals (including escaped metacharacters via `\\`)
- concatenation
- groups with alternation: `(a|b|c)`
- char classes: `[a-z0-9]` and explicit sets like `[abc]`
- quantifiers: `{m,n}`, `{m}`, `?`, `+`, `*` (bounded by `maxRepeat`)

Hard errors:
- `[^...]`, lookarounds, backrefs, non-capturing groups `(?:...)`, nested char classes, or unbalanced syntax => throw `Error('unsupported_regex')`

**Step 2: Run test to verify it passes**

```bash
cd mail-worker && pnpm exec vitest run test/regex-gen.spec.js
```

Expected: PASS.

**Step 3: Commit**

```bash
git add mail-worker/src/utils/regex-gen.js
git commit -m "feat: add simplified regex generator"
```

---

### Task 3: Add Unit Tests For Batch Register Core (Partial Success)

**Files:**
- Create: `mail-worker/test/batch-register-impl.spec.js`

**Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { batchRegisterImpl } from '../src/service/batch-register-service';
import { mulberry32 } from '../src/utils/regex-gen';

describe('batchRegisterImpl', () => {
  it('returns fewer than n with exhausted_attempts when collisions dominate', async () => {
    const rng = mulberry32(1);

    const existing = new Set();
    const createCalls = [];

    const res = await batchRegisterImpl(
      {
        n: 5,
        rules: ['u[0-9]{2}'],
        domainList: ['example.com'],
        passwordLen: 8,
        maxAttempts: 5, // intentionally too small
        maxRepeat: 16,
        maxOutputLen: 64,
        minEmailPrefix: 1,
        emailPrefixFilter: [],
      },
      {
        rng,
        isEmailTaken: async (email) => existing.has(email.toLowerCase()),
        isEmailDeleted: async () => false,
        createAccount: async ({ email, password }) => {
          existing.add(email.toLowerCase());
          createCalls.push({ email, password });
          return { email, password };
        },
      }
    );

    expect(res.requested).toBe(5);
    expect(res.created).toBeLessThan(5);
    expect(res.accounts).toHaveLength(res.created);
    expect(res.failures.some(f => f.reason_code === 'exhausted_attempts')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd mail-worker && pnpm exec vitest run test/batch-register-impl.spec.js
```

Expected: FAIL because `batchRegisterImpl` does not exist.

**Step 3: Commit**

```bash
git add mail-worker/test/batch-register-impl.spec.js
git commit -m "test: add batch register core spec"
```

---

### Task 4: Implement Batch Register Core Logic (Pure)

**Files:**
- Create: `mail-worker/src/service/batch-register-service.js`
- Modify: `mail-worker/src/service/public-service.js` (optional: none; prefer separate service)

**Step 1: Implement `batchRegisterImpl`**

Export a pure function:

```js
export async function batchRegisterImpl(input, deps) { /* ... */ }
```

`input` fields:
- `n`
- `rules` (array)
- `domainList` (array of domains, without `@`)
- `passwordLen`
- `maxAttempts`
- `maxRepeat`, `maxOutputLen`
- `minEmailPrefix`, `emailPrefixFilter`

`deps`:
- `rng` function
- `isEmailTaken(email)`
- `isEmailDeleted(email)`
- `createAccount({ email, password, rule })` returns `{ email, password }`

Behavior:
- Validate input and rules; if missing => throw error that the route will map to `invalid_env_rules`.
- Loop attempts until `created === n` or attempts exhausted.
- Each attempt:
  - pick rule randomly
  - generate prefix using `generateFromRule`
  - pick domain (random)
  - compose email
  - validate:
    - prefix length >= `minEmailPrefix`
    - prefix not containing any filtered substrings
    - local-part length <= 64
    - `verifyUtils.isEmail`
  - if taken/deleted, add failure and continue
  - call `createAccount`
- If attempts exhausted and created < n, add a final failure `{reason_code:'exhausted_attempts'}`

Map errors to reason codes in failures; do not throw for per-attempt failures.

**Step 2: Run tests**

```bash
cd mail-worker && pnpm exec vitest run test/batch-register-impl.spec.js
```

Expected: PASS.

**Step 3: Commit**

```bash
git add mail-worker/src/service/batch-register-service.js
git commit -m "feat: add batch register core implementation"
```

---

### Task 5: Wire Public API Route `/public/batchRegister`

**Files:**
- Modify: `mail-worker/src/api/public-api.js`
- Modify: `mail-worker/src/hono/webs.js` (no change expected)

**Step 1: Add route handler**

In `public-api.js` add:

```js
import batchRegisterService from '../service/batch-register-service';

app.post('/public/batchRegister', async (c) => {
  const data = await batchRegisterService.batchRegister(c, await c.req.json());
  return c.json(result.ok(data));
});
```

**Step 2: Implement `batchRegister(c, params)` wrapper**

In `batch-register-service.js`, add default export with method `batchRegister(c, params)` that:
- reads and parses env:
  - `BATCH_REGISTER_REGEX_RULES`
  - `BATCH_REGISTER_MAX_N`, etc
  - parse domain list robustly if string JSON
- reads settings via `settingService.query(c)` to get `minEmailPrefix` and `emailPrefixFilter`
- checks account existence via `accountService.selectByEmailIncludeDel`
  - if exists and `isDel=DELETE` => `deleted_not_reusable`
  - if exists => `already_exists`
- creates user+account via drizzle:
  - generate password (length)
  - hash password using `crypto-utils.hashPassword`
  - pick default role via `roleService.selectDefaultRole(c)`
  - `userService.insert(c, { email, password: hash, salt, type, regKeyId: 0 })`
  - `accountService.insert(c, { userId, email, name: emailUtils.getName(email) })`
  - call `userService.updateUserInfo(c, userId, true)`

Return the `batchRegisterImpl(...)` result.

**Step 3: Commit**

```bash
git add mail-worker/src/api/public-api.js mail-worker/src/service/batch-register-service.js
git commit -m "feat: add /public/batchRegister endpoint"
```

---

### Task 6: Add Minimal Route-Level Test (Optional If Test Harness Works)

**Files:**
- Create: `mail-worker/test/public-batch-register.route.spec.js`
- Modify: `mail-worker/vitest.config.js` (only if needed)

**Step 1: Ensure Vitest can run**

If current Cloudflare pool config is broken due to missing `wrangler.jsonc`, update it to point at an existing config that does not trigger builds:

- Change `mail-worker/vitest.config.js` `configPath` to `./wrangler-dev.toml`.

**Step 2: Write failing test that calls handler directly**

Prefer to import the service and call `batchRegisterImpl` (already covered). If route test is added, mock `c.env` and call `worker.fetch` with `/api/public/batchRegister` and correct `Authorization`.

**Step 3: Commit**

```bash
git add mail-worker/vitest.config.js mail-worker/test/public-batch-register.route.spec.js
git commit -m "test: add public batch register route coverage"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `README-en.md`

Add a short section documenting:
- endpoint `POST /api/public/batchRegister`
- required env `BATCH_REGISTER_REGEX_RULES`
- optional tuning env vars

**Commit**

```bash
git add README.md README-en.md
git commit -m "docs: document public batch register env and API"
```

---

### Task 8: Verification

Run targeted tests:

```bash
cd mail-worker && pnpm exec vitest run test/regex-gen.spec.js test/batch-register-impl.spec.js
```

Expected: PASS.

If CI/deps not installed, run in repo root:

```bash
pnpm --version
```

Then install as needed.
