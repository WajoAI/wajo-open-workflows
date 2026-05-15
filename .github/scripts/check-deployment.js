#!/usr/bin/env node
/**
 * Deployment Error Checker — Generic Edition
 *
 * Checks Vercel deployment logs for errors and uses Claude to analyze them.
 * Outputs fix suggestions as JSON. The workflow applies fixes and commits.
 *
 * No external dependencies required (uses native fetch).
 */

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!VERCEL_TOKEN) {
  console.log('VERCEL_TOKEN not configured -- skipping deployment check');
  process.exit(0);
}

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

if (!VERCEL_PROJECT_ID) {
  console.error('Missing VERCEL_PROJECT_ID');
  process.exit(1);
}

/**
 * Fetch latest deployment
 */
async function getLatestDeployment() {
  const params = new URLSearchParams({ projectId: VERCEL_PROJECT_ID, limit: '1' });
  if (VERCEL_TEAM_ID) params.set('teamId', VERCEL_TEAM_ID);

  const response = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });

  const data = await response.json();
  return data.deployments?.[0];
}

/**
 * Fetch deployment logs
 */
async function getDeploymentLogs(deploymentId) {
  const params = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
  const response = await fetch(`https://api.vercel.com/v2/deployments/${deploymentId}/events${params}`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  return await response.text();
}

/**
 * Extract error context from logs
 */
function extractErrorContext(logs) {
  const lines = logs.split('\n');
  const errorLines = [];
  const errorPatterns = [
    'Error', 'error', 'Failed', 'failed',
    'Cannot find module', 'Module not found',
    'SyntaxError', 'TypeError', 'ReferenceError',
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (errorPatterns.some(pattern => line.includes(pattern))) {
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length, i + 10);
      errorLines.push(...lines.slice(start, end));
    }
  }

  return [...new Set(errorLines)].join('\n');
}

/**
 * Use Claude to analyze the error
 */
async function analyzeError(deployment, errorContext) {
  console.log('\nAsking Claude to analyze the deployment error...\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `You are an expert developer fixing deployment errors.

Your job:
1. Analyze the deployment error logs
2. Identify the root cause
3. Create SPECIFIC FILE CHANGES to fix the issue

Common fixes:
- Missing module: fix the import path or add the missing file
- Wrong import path: fix the import statement
- Missing dependency: add to package.json
- Syntax error: fix the syntax

Return your response in this EXACT JSON format (no markdown fences):
{
  "analysis": "Brief explanation of the error",
  "rootCause": "What caused this error",
  "fixes": [
    {
      "type": "create_file" | "modify_file" | "run_command",
      "path": "relative/path/to/file.js",
      "content": "full file content (for create_file)",
      "changes": "description of changes (for modify_file)",
      "command": "command to run (for run_command)"
    }
  ]
}`,
      messages: [{
        role: 'user',
        content: `Deployment ${deployment.uid} failed. Please analyze and provide fixes.

**Deployment Info:**
- State: ${deployment.state}
- Branch: ${deployment.meta?.githubCommitRef || 'unknown'}
- Commit: ${deployment.meta?.githubCommitSha?.substring(0, 7) || 'unknown'}
- Message: ${deployment.meta?.githubCommitMessage || 'unknown'}

**Error Logs:**
${errorContext}

Please provide specific fixes in the JSON format specified.`,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);

  const text = (await res.json()).content[0]?.text || '';

  // Extract JSON
  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) jsonText = jsonMatch[1];

  const start = jsonText.indexOf('{');
  if (start === -1) throw new Error('No JSON in response');
  let lastErr;
  for (let end = jsonText.lastIndexOf('}'); end >= start; end = jsonText.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(jsonText.slice(start, end + 1)); } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not parse JSON: ${lastErr?.message}`);
}

/**
 * Apply fixes to the filesystem
 */
async function applyFixes(fixes) {
  const { writeFileSync } = await import('fs');
  const { execSync } = await import('child_process');

  console.log(`\nApplying ${fixes.length} fix(es)...\n`);

  for (const fix of fixes) {
    try {
      switch (fix.type) {
        case 'create_file':
          console.log(`  Creating ${fix.path}`);
          writeFileSync(fix.path, fix.content);
          break;
        case 'modify_file':
          if (fix.content) {
            console.log(`  Modifying ${fix.path}`);
            writeFileSync(fix.path, fix.content);
          }
          break;
        case 'run_command':
          // Security: do NOT execute arbitrary commands from LLM output.
          // Only allow safe npm install commands.
          if (/^npm\s+install\b/.test(fix.command)) {
            console.log(`  Running: ${fix.command}`);
            execSync(fix.command, { stdio: 'inherit', timeout: 60000 });
          } else {
            console.log(`  Skipped unsafe command: ${fix.command}`);
          }
          break;
        default:
          console.log(`  Unknown fix type: ${fix.type}`);
      }
    } catch (error) {
      console.error(`  Fix failed: ${error.message}`);
    }
  }
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('\n=== Deployment Error Checker ===\n');

  const deployment = await getLatestDeployment();

  if (!deployment) {
    console.log('No deployments found');
    process.exit(0);
  }

  console.log(`Latest deployment: ${deployment.uid}`);
  console.log(`  State: ${deployment.state}`);
  console.log(`  Created: ${new Date(deployment.createdAt).toISOString()}`);

  if (deployment.state !== 'ERROR' && deployment.state !== 'FAILED') {
    console.log('\nDeployment is healthy -- no action needed\n');
    process.exit(0);
  }

  console.log('\nDeployment failed -- fetching logs...');

  const logs = await getDeploymentLogs(deployment.uid);
  const errorContext = extractErrorContext(logs);

  if (!errorContext) {
    console.log('No error context found in logs');
    process.exit(1);
  }

  console.log(`\nError context extracted (${errorContext.length} chars)`);

  const solution = await analyzeError(deployment, errorContext);

  console.log(`\nAnalysis: ${solution.analysis}`);
  console.log(`Root Cause: ${solution.rootCause}`);

  if (!solution.fixes || solution.fixes.length === 0) {
    console.log('\nNo automatic fixes available');
    process.exit(1);
  }

  await applyFixes(solution.fixes);

  console.log('\nFixes applied. Changes will be committed by the workflow.\n');
  process.exit(0);
}

main().catch(error => {
  console.error(`\nFatal error: ${error.message}`);
  process.exit(1);
});
