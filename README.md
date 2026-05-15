# wajo-open-workflows

Reusable GitHub Actions that add AI code review, auto-fix, and documentation analysis to any repo. Powered by Claude.

## Agent Catalog

| Agent | What it does | Trigger |
|-------|-------------|---------|
| **TLM PR Review** | AI code review with structured verdict, blocking issues, and notes | PR opened/updated |
| **TLM Auto-Fix** | Fixes blocking issues flagged by TLM review | Triggered by TLM Review |
| **TLM Docs** | Analyzes code changes and posts documentation update suggestions | Push to main |
| **Codex Review** | Posts `@codex review` to trigger GitHub Copilot review | PR opened |
| **Auto-Fix Comments** | Fixes bot review comments and failing CI tests | Review comment/test failure |
| **Auto-Fix Deployment** | Fixes Vercel deployment errors automatically | Push to main |

## Quick Start

### 1. Add your Anthropic API key as a repo secret

```bash
gh secret set ANTHROPIC_API_KEY
```

### 2. Copy a caller workflow into your repo

```bash
mkdir -p .github/workflows
```

**AI PR Review** (most common starting point):

```bash
cat > .github/workflows/ai-review.yml << 'YAML'
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: write
  actions: write

jobs:
  review:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
YAML
```

### 3. Done

Next PR triggers the review. No dependencies to install, no scripts to maintain.

> **Note:** The `permissions` block is required. Reusable workflows can only use permissions that the caller grants. If your org uses restrictive default token permissions, the caller must explicitly grant `pull-requests: write`, `contents: write`, and `actions: write`.

---

## All Agents — Setup Instructions

### TLM PR Review

Reviews every PR with Claude. Posts structured comments with verdict, blocking issues, and notes. Triggers auto-fix for blocking issues.

```yaml
# .github/workflows/ai-review.yml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: write
  actions: write

jobs:
  review:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Options:**

```yaml
    with:
      model: claude-opus-4-6          # default; or claude-sonnet-4-6 for speed
      max_diff_lines: 2500             # max lines of diff sent to Claude
      autofix_workflow: ai-autofix.yml # trigger auto-fix on blocking issues
      extra_review_instructions: |     # project-specific review rules
        - All endpoints must have auth
        - No inline SQL queries
      project_context: |               # describe your stack
        Next.js 14 + Supabase + Tailwind
```

**Required secrets:** `ANTHROPIC_API_KEY`

---

### TLM Auto-Fix

Fixes blocking issues from TLM review. Usually triggered automatically by TLM Review (if `autofix_workflow` is set), but can be called manually.

```yaml
# .github/workflows/ai-autofix.yml
name: AI Auto-Fix
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR number to fix
        required: true
      issues:
        description: JSON array of blocking issues
        required: true

permissions:
  pull-requests: write
  contents: write
  actions: write

jobs:
  fix:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-autofix.yml@main
    with:
      pr_number: ${{ inputs.pr_number }}
      issues: ${{ inputs.issues }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Required secrets:** `ANTHROPIC_API_KEY`

---

### TLM Docs Review

Analyzes code changes and posts documentation update suggestions as commit comments.

```yaml
# .github/workflows/ai-docs.yml
name: AI Docs Review
on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  docs:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-docs.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Options:**

```yaml
    with:
      model: claude-sonnet-4-6    # default
      category: auto               # auto, all, dev, product, engineering, interfaces
      category_config: |           # custom file-to-category mapping (JSON)
        [{"pattern": "^lib/", "categories": ["engineering"]}]
```

**Required secrets:** `ANTHROPIC_API_KEY`

---

### Codex Review

Triggers GitHub Copilot code review on eligible PRs. No API key needed.

```yaml
# .github/workflows/codex-review.yml
name: Codex Review
on:
  pull_request:
    types: [opened, ready_for_review]

permissions:
  pull-requests: write

jobs:
  codex:
    uses: wajoai/wajo-open-workflows/.github/workflows/codex-review.yml@main
```

**Required secrets:** None (uses `GITHUB_TOKEN`)

---

### Auto-Fix PR Comments

Automatically fixes code review comments from bots and failing CI tests using Claude CLI.

```yaml
# .github/workflows/ai-fix-comments.yml
name: AI Fix Comments
on:
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  check_run:
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    uses: wajoai/wajo-open-workflows/.github/workflows/auto-fix-pr-comments.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Required secrets:** `ANTHROPIC_API_KEY`

---

### Auto-Fix Deployment

Checks Vercel deployment logs for errors and auto-fixes them with Claude.

```yaml
# .github/workflows/ai-fix-deployment.yml
name: AI Fix Deployment
on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  fix:
    uses: wajoai/wajo-open-workflows/.github/workflows/auto-fix-deployment.yml@main
    with:
      vercel_team_id: ''  # optional
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

**Required secrets:** `ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`

---

## Full Suite

Want all agents at once? Copy `examples/full-suite.yml` to `.github/workflows/ai-suite.yml`.

```bash
curl -o .github/workflows/ai-suite.yml \
  https://raw.githubusercontent.com/wajoai/wajo-open-workflows/main/examples/full-suite.yml
```

Then set your secrets:

```bash
gh secret set ANTHROPIC_API_KEY
gh secret set VERCEL_TOKEN          # only if using deployment fix
gh secret set VERCEL_PROJECT_ID     # only if using deployment fix
```

## Self-Improvement Loop

The TLM reviewer learns from its mistakes. Create `.github/TLM_LEARNINGS.md` in your repo:

```bash
mkdir -p .github
cat > .github/TLM_LEARNINGS.md << 'EOF'
# TLM Learnings

Patterns the TLM reviewer should watch for in this project.

---
EOF
git add .github/TLM_LEARNINGS.md && git commit -m "chore: add TLM learnings"
```

After each review run with blocking issues, the workflow appends new patterns to this file. Future reviews include these patterns in the prompt.

## How It Works

Your repo has thin caller workflows (5-15 lines). The actual logic runs from this repo's reusable workflows. Scripts are fetched at runtime by checking out `wajoai/wajo-open-workflows`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for flow diagrams.
See [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) for all configuration options.

## Permissions

Reusable workflows can only use permissions the caller explicitly grants. Add a `permissions` block to your caller workflow:

```yaml
permissions:
  pull-requests: write   # post review comments
  contents: write        # push fixes, update learnings
  actions: write         # trigger auto-fix workflows
```

If your GitHub org uses restrictive default token permissions (`read` only), the caller **must** include this block or the workflow will fail with `startup_failure`.

## Requirements

- GitHub Actions enabled on your repo
- `ANTHROPIC_API_KEY` secret (get one at [console.anthropic.com](https://console.anthropic.com))
- Node.js 20 (provided by the workflows)
- For deployment fix: Vercel project with API token

## License

MIT
