# Customization Guide

## Custom Review Instructions

Add project-specific review rules via the `extra_review_instructions` input:

```yaml
jobs:
  review:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-pr-review.yml@main
    with:
      extra_review_instructions: |
        - All API endpoints must have rate limiting
        - Database queries must use parameterized statements
        - React components must not use inline styles
        - All public functions must have JSDoc comments
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Project Context

Provide context about your tech stack so the reviewer understands your codebase:

```yaml
    with:
      project_context: |
        This is a Next.js 14 app with App Router.
        Backend uses Supabase (PostgreSQL) and Firebase Auth.
        State management: Zustand.
        CSS: Tailwind CSS.
```

## Model Selection

### PR Review
Default: `claude-opus-4-6` (most thorough)

```yaml
    with:
      model: claude-sonnet-4-6  # faster, cheaper
```

### Docs Review
Default: `claude-sonnet-4-6`

```yaml
    with:
      model: claude-opus-4-6  # more thorough docs analysis
```

## Custom File Category Mapping (Docs Agent)

Override the default file-to-category mapping for the docs agent:

```yaml
    with:
      category_config: |
        [
          { "pattern": "^lib/api/", "categories": ["interfaces", "engineering"] },
          { "pattern": "^components/", "categories": ["product", "dev"] },
          { "pattern": "^prisma/", "categories": ["engineering"] },
          { "pattern": "^docs/api/", "categories": ["interfaces"] }
        ]
```

Each entry has:
- `pattern`: Regex pattern matched against file paths
- `categories`: Array of `dev`, `product`, `engineering`, `interfaces`

## TLM Learnings (Self-Improvement)

Create `.github/TLM_LEARNINGS.md` in your repo to enable the self-improvement loop:

```bash
mkdir -p .github
cat > .github/TLM_LEARNINGS.md << 'EOF'
# TLM Learnings

Patterns the TLM reviewer should watch for in this project.

---
EOF
git add .github/TLM_LEARNINGS.md
git commit -m "chore: add TLM learnings file"
```

The file will be automatically updated after review runs that find blocking
issues. You can also manually add patterns:

```markdown
## 2026-01-15 -- Always check auth before database writes

**What was missed**: A new endpoint wrote to the database without checking
the user's authentication token.

**Pattern to flag**: Any route handler that calls `db.insert()` or
`db.update()` without a preceding auth check.

**Correct pattern**:
\`\`\`typescript
const user = await requireAuth(req);
await db.insert(table).values({ ...data, userId: user.id });
\`\`\`
```

## Diff Size Limit

Control how much of the PR diff is sent to Claude:

```yaml
    with:
      max_diff_lines: 5000  # default: 2500
```

Larger values give Claude more context but cost more tokens. For monorepo PRs,
you may want to increase this.

## Vercel Deployment Fix

For the deployment fix agent, pass your Vercel team ID if applicable:

```yaml
jobs:
  fix:
    uses: wajoai/wajo-open-workflows/.github/workflows/auto-fix-deployment.yml@main
    with:
      vercel_team_id: team_abc123
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

## Scheduled Reviews

Run TLM review on a schedule to catch all open PRs:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
  schedule:
    - cron: '0 */4 * * *'  # every 4 hours

jobs:
  review:
    uses: wajoai/wajo-open-workflows/.github/workflows/tlm-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Disabling Specific Agents

Only use the agents you want. Each workflow is independent. You don't need
to use all of them. Just copy the caller workflows for the agents you want.
