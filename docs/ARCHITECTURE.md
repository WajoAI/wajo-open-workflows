# Architecture

## How Reusable Workflows Work

```
Your Repo                          wajoai/wajo-open-workflows
---------                          --------------------------
.github/workflows/                 .github/workflows/
  ai-review.yml  ───uses──────>     tlm-pr-review.yml
  ai-docs.yml    ───uses──────>     tlm-docs.yml
  ...                              .github/scripts/
                                     tlm-review.mjs
                                     tlm-docs.mjs
                                     fetch-pr-context.js
                                     check-deployment.js
```

Your repo contains thin "caller" workflows (3-10 lines of YAML). The actual
logic lives in this repo's reusable workflows, which check out their own
scripts at runtime.

## Agent Flow Diagram

```
PR opened/updated
       |
       v
+------------------+     +------------------+
| TLM PR Review    |     | Codex Review     |
| (Claude Opus)    |     | (GitHub Copilot) |
+--------+---------+     +------------------+
         |
    blocking issues?
    /            \
  yes             no
   |               |
   v               v
+------------------+   APPROVE
| TLM Auto-Fix    |   (comment posted)
| (Claude CLI)    |
+--------+---------+
         |
    fixes pushed
         |
         v
+------------------+
| Verify fixes     |
| (Claude API)     |
+--------+---------+
         |
    still broken?
    /            \
  yes             no
   |               |
   v               v
  Re-trigger      Post success
  TLM Review      comment
```

## Auto-Fix PR Comments Flow

```
Bot posts review comment     CI test fails
          |                       |
          v                       v
   +------+-----------------------+------+
   |     Auto-Fix PR Comments            |
   |  1. Fetch bot comments / test logs  |
   |  2. Build prompt                    |
   |  3. Run Claude CLI                  |
   |  4. Commit + push fixes             |
   +-------------------------------------+
```

## Deployment Fix Flow

```
Push to main
     |
     v
+------------------------+
| Auto-Fix Deployment    |
| 1. Fetch Vercel logs   |
| 2. Extract errors      |
| 3. Claude analyzes     |
| 4. Apply fixes         |
| 5. Commit + push       |
+------------------------+
```

## Docs Review Flow

```
Push to main
     |
     v
+------------------------+
| TLM Docs Review        |
| 1. Get diff            |
| 2. Classify files      |
| 3. Per-category Claude |
| 4. Post commit comment |
+------------------------+
```

## Self-Improvement Loop

The TLM Review agent maintains a `TLM_LEARNINGS.md` file in your repo.
After each review run with blocking issues, it calls Claude to extract
new patterns and appends them to the file. Future reviews include these
learnings in the prompt, creating a feedback loop that gets smarter
over time.

To enable this:
1. Create `.github/TLM_LEARNINGS.md` in your repo (can be empty)
2. The workflow will auto-update it after review runs

## Security Model

- Secrets (`ANTHROPIC_API_KEY`, etc.) are passed via `workflow_call` secrets
- They never appear in logs or script output
- `GITHUB_TOKEN` is automatically available with the caller's permissions
- Scripts run in the caller's context with the caller's permissions
- Fork PRs are skipped (no secrets available)
