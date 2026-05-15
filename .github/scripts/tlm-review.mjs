#!/usr/bin/env node
/**
 * TLM (Technical Lead Manager) PR Review — Generic Edition
 *
 * For every open, non-draft PR that has new commits since the last TLM review,
 * calls Claude with a CTO/TLM prompt and posts a structured review comment.
 * If blocking issues are found, triggers the tlm-autofix workflow.
 *
 * At the end, writes /tmp/tlm-blocking-issues.json with all blocking issues
 * found this run — consumed by the "Update TLM learnings" workflow step.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load accumulated learnings so the reviewer knows what patterns to catch
let TLM_LEARNINGS = '';
try {
  TLM_LEARNINGS = readFileSync(join(__dirname, '../TLM_LEARNINGS.md'), 'utf8');
} catch {
  // File may not exist yet; proceed without it
}

const MODEL = process.env.TLM_MODEL || 'claude-opus-4-6';
const MAX_DIFF_LINES = parseInt(process.env.MAX_DIFF_LINES || '2500', 10);
const TLM_MARKER = '\u{1F3D7}\uFE0F **TLM Review**';

const EXTRA_INSTRUCTIONS = process.env.EXTRA_INSTRUCTIONS || '';
const PROJECT_CONTEXT = process.env.PROJECT_CONTEXT || '';

const { GITHUB_TOKEN, ANTHROPIC_API_KEY, REPO, PR_NUMBER } = process.env;

if (!GITHUB_TOKEN || !ANTHROPIC_API_KEY || !REPO) {
  console.error('Required env vars: GITHUB_TOKEN, ANTHROPIC_API_KEY, REPO');
  process.exit(1);
}

const GH = {
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
  },
};

// -- GitHub helpers -----------------------------------------------------------

async function ghGet(path) {
  const r = await fetch(`https://api.github.com${path}`, GH);
  if (!r.ok) throw new Error(`GH ${r.status}: ${path}`);
  return r.json();
}

async function ghPost(path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method: 'POST', ...GH, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GH POST ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getOpenPRs() {
  let all = [];
  let page = 1;
  while (true) {
    const data = await ghGet(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
    all = all.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return all.filter(pr =>
    !pr.draft &&
    !pr.user.login.includes('[bot]') &&
    pr.user.login !== 'dependabot'
  );
}

async function getLastTLMComment(prNumber) {
  const comments = await ghGet(`/repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
  const tlm = comments.filter(c =>
    c.user.login === 'github-actions[bot]' &&
    c.body.includes(TLM_MARKER)
  );
  return tlm.length ? tlm[tlm.length - 1] : null;
}

async function getPRDiff(prNumber) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/pulls/${prNumber}`, {
    headers: { ...GH.headers, Accept: 'application/vnd.github.v3.diff' },
  });
  if (!r.ok) return '';
  const text = await r.text();
  const lines = text.split('\n');
  return lines.length > MAX_DIFF_LINES
    ? lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n\n[Truncated: ${lines.length} total lines]`
    : text;
}

async function getCopilotComments(prNumber) {
  try {
    const reviews = await ghGet(`/repos/${REPO}/pulls/${prNumber}/reviews?per_page=20`);
    const copilot = reviews.filter(r => r.user?.login === 'copilot-pull-request-reviewer[bot]');
    if (!copilot.length) return 'No Copilot review yet.';

    const latest = copilot[copilot.length - 1];
    const comments = await ghGet(`/repos/${REPO}/pulls/${prNumber}/reviews/${latest.id}/comments`);
    const lines = comments.map(c => `- [${c.path}] ${c.body.slice(0, 200)}`);
    return `Copilot summary: ${latest.body?.slice(0, 300) || 'none'}\n\nInline comments:\n${lines.join('\n') || 'none'}`;
  } catch {
    return 'No Copilot review available.';
  }
}

async function getChecks(sha) {
  try {
    const data = await ghGet(`/repos/${REPO}/commits/${sha}/check-runs`);
    return data.check_runs.map(c => `${c.name}: ${c.conclusion || c.status}`).join(', ') || 'No checks found';
  } catch (e) {
    console.warn(`  Could not fetch checks: ${e.message}`);
    return 'Checks unavailable';
  }
}

// -- Claude -------------------------------------------------------------------

const TLM_PROMPT = `You are a Technical Lead Manager (TLM) doing a pre-merge review. You have full context: the diff, CI status, and any existing Copilot review comments.

Your job: identify issues that would block a production merge. Be direct and opinionated.

## Anti-hallucination rules

- Only flag issues you can point to a SPECIFIC line or pattern in the diff. If you cannot quote the problematic code, do not flag it.
- Do NOT invent hypothetical issues. If the diff is clean, APPROVE it. An empty blocking array is the correct output for a good PR.
- Do NOT add notes just to have something to say. Empty notes array is fine. Silence is better than filler.
- Do NOT flag missing tests, missing error handling, or missing validation unless the diff introduces a NEW code path that clearly needs it. Existing untested code is out of scope.
- Do NOT re-flag issues already raised by Copilot unless you have additional context.
- If you are unsure whether something is a real issue, do NOT mark it as blocking. Instead, add it to notes with "Uncertain — human reviewer should check: ..." so a human expert can make the call.
- You only see the DIFF, not the full file. Do NOT assume a function is uncached, a variable is unnormalized, or a guard is missing just because you cannot see it in the diff. If the relevant code could plausibly exist outside the diff context, do NOT flag it as blocking. At most, add it to notes with "Uncertain" prefix.
- Be rigorous and critical. But if you genuinely cannot find real issues, APPROVE — do not manufacture feedback to justify your existence.

Review for:
1. CORRECTNESS — bugs, logic errors, missing null checks, wrong async handling
2. SECURITY — auth bypasses, data leakage, injection vectors, missing validation
3. MISSING IMPLEMENTATION — PR title promises X but code doesn't deliver X
4. BREAKING CHANGES — removed fallbacks without migration, API changes
5. COPILOT COMMENTS — are the Copilot-flagged issues real? Which ones need fixing?
6. TEST COVERAGE — behavior changes without tests, missing error path coverage

Return ONLY valid JSON (no markdown fences):
{
  "verdict": "APPROVE" | "NEEDS_WORK",
  "summary": "2-3 sentence assessment",
  "blocking": [
    {
      "severity": "CRITICAL" | "HIGH",
      "file": "path/to/file.js or null",
      "issue": "Clear description of the problem",
      "fix": "What needs to change"
    }
  ],
  "notes": ["Non-blocking observations (optional, max 3, only if genuinely useful — empty array is fine)"]
}

If no blocking issues: verdict=APPROVE, empty blocking array.
Maximum 5 blocking items — only the most impactful.
Be thorough and critical — but never invent issues. If unsure, surface it as a note for human review rather than blocking.${EXTRA_INSTRUCTIONS ? `

## Additional Review Instructions

${EXTRA_INSTRUCTIONS}` : ''}${TLM_LEARNINGS ? `

## Past Learnings — Patterns We've Missed Before

These are bugs and anti-patterns the TLM has historically overlooked. Check for these explicitly:

${TLM_LEARNINGS}` : ''}`;

async function callClaude(prTitle, prBody, diff, copilotComments, checks) {
  const userMsg = `## PR: ${prTitle}

${prBody ? `Description: ${prBody.slice(0, 500)}` : ''}
${PROJECT_CONTEXT ? `\n## Project Context\n${PROJECT_CONTEXT}` : ''}
## CI Status
${checks}

## Copilot Review
${copilotComments}

## Diff
\`\`\`diff
${diff}
\`\`\``;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: TLM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const text = (await res.json()).content[0]?.text || '';
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let lastErr;
  for (let end = text.lastIndexOf('}'); end >= start; end = text.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not extract valid JSON from response: ${lastErr?.message}`);
}

// -- Post review comment ------------------------------------------------------

function formatComment(review, prNumber, headSha) {
  const icon = review.verdict === 'APPROVE' ? '\u2705' : '\uD83D\uDD34';
  const lines = [
    `${TLM_MARKER} — ${icon} **${review.verdict}**`,
    '',
    review.summary,
    '',
  ];

  if (review.blocking?.length) {
    lines.push('### Blocking Issues');
    for (const b of review.blocking) {
      lines.push(`\n**[\`${b.severity}\`]** ${b.file ? `\`${b.file}\`` : ''} — ${b.issue}`);
      lines.push(`> Fix: ${b.fix}`);
    }
  }

  if (review.notes?.length) {
    lines.push('\n<details><summary>Notes</summary>\n');
    for (const n of review.notes) lines.push(`- ${n}`);
    lines.push('\n</details>');
  }

  lines.push(`\n---\n<sub>\uD83E\uDD16 TLM \u00B7 [Claude ${MODEL}](https://anthropic.com) \u00B7 SHA: \`${headSha.slice(0,8)}\`</sub>`);
  return lines.join('\n');
}

// -- Trigger auto-fix ---------------------------------------------------------

async function triggerAutoFix(prNumber, issues) {
  try {
    await ghPost(`/repos/${REPO}/actions/workflows/tlm-autofix.yml/dispatches`, {
      ref: 'main',
      inputs: {
        pr_number: String(prNumber),
        issues: JSON.stringify(issues),
      },
    });
    console.log(`  Triggered auto-fix for PR #${prNumber}`);
  } catch (e) {
    // Auto-fix workflow may not exist in the caller's repo — that's OK
    console.log(`  Auto-fix trigger skipped (workflow may not exist): ${e.message}`);
  }
}

// -- Main ---------------------------------------------------------------------

const prs = PR_NUMBER
  ? [await ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}`)]
  : await getOpenPRs();

console.log(`Reviewing ${prs.length} PR(s)...`);

const allBlockingIssues = [];

for (const pr of prs) {
  console.log(`\nPR #${pr.number}: ${pr.title}`);

  if (pr.state !== 'open') {
    console.log(`  PR is ${pr.state}, skipping.`);
    continue;
  }

  const lastComment = await getLastTLMComment(pr.number);
  if (lastComment?.body?.includes(`SHA: \`${pr.head.sha.slice(0,8)}\``)) {
    console.log(`  Already reviewed at ${pr.head.sha.slice(0,8)}, skipping.`);
    continue;
  }

  try {
    const [diff, copilotComments, checks] = await Promise.all([
      getPRDiff(pr.number),
      getCopilotComments(pr.number),
      getChecks(pr.head.sha),
    ]);

    if (!diff.trim() || diff.trim().length < 20) {
      console.log(`  No meaningful diff, skipping.`);
      continue;
    }

    console.log(`  Calling Claude TLM...`);
    const review = await callClaude(pr.title, pr.body, diff, copilotComments, checks);
    console.log(`  Verdict: ${review.verdict}, ${review.blocking?.length || 0} blocking issues`);

    const comment = formatComment(review, pr.number, pr.head.sha);
    await ghPost(`/repos/${REPO}/issues/${pr.number}/comments`, { body: comment });
    console.log(`  Posted TLM review comment.`);

    if (review.verdict === 'NEEDS_WORK' && review.blocking?.length) {
      allBlockingIssues.push(...review.blocking.map(b => ({ ...b, pr: pr.number })));
      await triggerAutoFix(pr.number, review.blocking);
    }
  } catch (err) {
    console.error(`  Failed to review PR #${pr.number}: ${err.message}`);
  }
}

writeFileSync('/tmp/tlm-blocking-issues.json', JSON.stringify(allBlockingIssues, null, 2));
console.log(`\nWrote ${allBlockingIssues.length} blocking issue(s) to /tmp/tlm-blocking-issues.json`);

console.log('\nDone.');
