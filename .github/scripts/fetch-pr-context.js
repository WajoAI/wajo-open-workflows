#!/usr/bin/env node
/**
 * fetch-pr-context.js — Generic Edition
 *
 * Fetches GitHub data for the current PR event and writes a prompt to stdout
 * for the Claude CLI to act on. Prints "SKIP" if there's nothing to do.
 *
 * Used by: auto-fix-pr-comments.yml
 */

const GITHUB_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const PR_NUMBER = process.env.PR_NUMBER;
const EVENT_NAME = process.env.EVENT_NAME;
const MODE = process.env.MODE; // 'comments' | 'tests'
const CHECK_RUN_ID = process.env.CHECK_RUN_ID;
const PROJECT_NAME = process.env.PROJECT_NAME || 'this project';

async function ghGet(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}`);
  return res.json();
}

async function getBotComments() {
  const [reviewComments, reviews] = await Promise.all([
    ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}/comments`),
    ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews`),
  ]);

  const items = [];

  // Inline review comments from bots that haven't been replied to yet
  for (const c of reviewComments) {
    if (!c.user.login.endsWith('[bot]')) continue;
    if (c.in_reply_to_id) continue;
    items.push(`[${c.user.login}] ${c.path}:${c.line ?? c.original_line}\n${c.body}\nDiff context:\n${c.diff_hunk}`);
  }

  // Full review body comments from bots
  for (const r of reviews) {
    if (!r.user.login.endsWith('[bot]')) continue;
    if (!r.body?.trim()) continue;
    items.push(`[${r.user.login}] review body:\n${r.body}`);
  }

  return items;
}

async function getTestFailureLog() {
  if (!CHECK_RUN_ID) return null;
  try {
    const checkRun = await ghGet(`/repos/${REPO}/check-runs/${CHECK_RUN_ID}`);
    const runId = checkRun.check_suite?.id;
    if (!runId) return null;

    const jobs = await ghGet(`/repos/${REPO}/actions/runs/${runId}/jobs`);
    const failedJob = jobs.jobs?.find(j => j.conclusion === 'failure');
    if (!failedJob) return null;

    const logRes = await fetch(failedJob.logs_url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });
    const log = await logRes.text();

    const lines = log.split('\n');
    const failIdx = lines.findIndex(l => l.includes('FAIL ') || l.match(/\u25CF [A-Z]/));
    return failIdx >= 0
      ? lines.slice(failIdx, failIdx + 150).join('\n')
      : lines.slice(-150).join('\n');
  } catch (e) {
    return null;
  }
}

async function main() {
  if (EVENT_NAME === 'check_run' || MODE === 'tests') {
    const log = await getTestFailureLog();
    if (!log) { process.stdout.write('SKIP'); return; }

    process.stdout.write(`You are fixing a failing CI test suite on PR #${PR_NUMBER} of ${PROJECT_NAME}.

Here is the test failure output:
${log}

Instructions:
- Read the failing test file(s) and the source files they test.
- Fix the root cause in the implementation (prefer fixing the source over changing tests, unless the test itself is clearly wrong).
- Only modify files that are necessary. Do not touch unrelated code.`);

  } else {
    const comments = await getBotComments();
    if (comments.length === 0) { process.stdout.write('SKIP'); return; }

    process.stdout.write(`You are fixing code review comments left by automated agents on PR #${PR_NUMBER} of ${PROJECT_NAME}.

The following unaddressed review comments were posted by bots:

${comments.map((c, i) => `--- Comment ${i + 1} ---\n${c}`).join('\n\n')}

Instructions:
- Read the relevant source files mentioned in the comments.
- Implement the minimal changes that address every comment.
- Only modify files that need changing. Do not touch unrelated code.
- Do not reply to or dismiss the comments -- just fix the code.`);
  }
}

main().catch(err => {
  process.stderr.write(`fetch-pr-context error: ${err.message}\n`);
  process.stdout.write('SKIP');
});
