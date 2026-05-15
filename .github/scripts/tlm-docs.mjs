#!/usr/bin/env node
/**
 * TLM Docs Agent — Generic Edition
 *
 * Analyzes code changes, generates documentation update summaries per category,
 * and writes a markdown comment to /tmp/tlm-docs-comment.md.
 * The workflow posts this as a commit comment — no files are committed.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname as pathDirname, join } from 'path';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
// ROOT must be the caller's repo root (process.cwd()), NOT the wajo-open-workflows checkout
const ROOT = process.cwd();

const MODEL = process.env.TLM_DOCS_MODEL || 'claude-sonnet-4-6';
const MAX_DIFF_LINES = parseInt(process.env.MAX_DIFF_LINES || '2500', 10);
const MAX_FILE_CHARS = 15000;
const MAX_CONTEXT_CHARS = 60000;

const VALID_CATEGORIES = ['dev', 'product', 'engineering', 'interfaces', 'all', 'auto'];

const { ANTHROPIC_API_KEY, CATEGORY } = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

if (CATEGORY && !VALID_CATEGORIES.includes(CATEGORY)) {
  console.error(`Invalid category "${CATEGORY}". Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  process.exit(1);
}

// -- File category mapping (generic defaults) ---------------------------------
// Users can override via CATEGORY_CONFIG env var (JSON string)

const DEFAULT_FILE_CATEGORY_MAP = [
  { pattern: '^src/api/', categories: ['interfaces', 'engineering'] },
  { pattern: '^src/routes/', categories: ['interfaces', 'engineering'] },
  { pattern: '^src/handlers/', categories: ['interfaces', 'engineering'] },
  { pattern: '^app/api/', categories: ['interfaces', 'engineering'] },
  { pattern: '^app/handlers/', categories: ['interfaces', 'engineering'] },
  { pattern: '^packages/', categories: ['interfaces', 'dev'] },
  { pattern: '^frontend/', categories: ['product', 'dev'] },
  { pattern: '^docs/', categories: ['product'] },
  { pattern: '^src/lib/', categories: ['engineering'] },
  { pattern: '^src/utils/', categories: ['engineering'] },
  { pattern: '^\\.env', categories: ['dev'] },
  { pattern: '^package\\.json$', categories: ['dev'] },
  { pattern: '^src/index\\.', categories: ['engineering', 'interfaces'] },
  { pattern: '^app/index\\.', categories: ['engineering', 'interfaces'] },
];

let FILE_CATEGORY_MAP;
try {
  const custom = process.env.CATEGORY_CONFIG;
  if (custom) {
    const parsed = JSON.parse(custom);
    FILE_CATEGORY_MAP = parsed.map(entry => ({
      pattern: new RegExp(entry.pattern),
      categories: entry.categories,
    }));
  }
} catch (e) {
  console.warn(`Warning: Could not parse CATEGORY_CONFIG: ${e.message}. Using defaults.`);
}

if (!FILE_CATEGORY_MAP) {
  FILE_CATEGORY_MAP = DEFAULT_FILE_CATEGORY_MAP.map(entry => ({
    pattern: new RegExp(entry.pattern),
    categories: entry.categories,
  }));
}

// -- Helpers ------------------------------------------------------------------

function readFile(relPath) {
  try {
    const content = readFileSync(join(ROOT, relPath), 'utf8');
    if (content.length > MAX_FILE_CHARS) {
      return content.slice(0, MAX_FILE_CHARS) + `\n\n[Truncated: ${content.length} chars total]`;
    }
    return content;
  } catch {
    return null;
  }
}

function readDir(relPath) {
  try {
    return readdirSync(join(ROOT, relPath));
  } catch {
    return [];
  }
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

// -- Diff analysis ------------------------------------------------------------

function classifyFiles(files) {
  const categories = new Set();
  for (const file of files) {
    let matched = false;
    for (const { pattern, categories: cats } of FILE_CATEGORY_MAP) {
      if (pattern.test(file)) {
        cats.forEach(c => categories.add(c));
        matched = true;
        break;
      }
    }
    if (!matched && (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.ts') || file.endsWith('.tsx'))) {
      categories.add('engineering');
    }
  }
  return [...categories];
}

function getDiff() {
  const diff = git('diff HEAD~1 HEAD --name-only');
  if (!diff) return { files: [], diffText: '' };

  const files = diff.split('\n').filter(Boolean);
  let diffText = git('diff HEAD~1 HEAD');
  const lines = diffText.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    diffText = lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n\n[Truncated: ${lines.length} total lines]`;
  }
  return { files, diffText };
}

// -- Context assembly per category --------------------------------------------

function assembleContext(category, diffText) {
  const parts = [];
  let totalChars = 0;

  function addPart(label, content) {
    if (!content) return;
    const section = `### ${label}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (totalChars + section.length > MAX_CONTEXT_CHARS) {
      console.log(`    Skipped ${label} (context budget exceeded)`);
      return;
    }
    totalChars += section.length;
    parts.push(section);
  }

  function addFile(label, relPath) {
    const content = readFile(relPath);
    if (content) addPart(label, content);
  }

  addPart('Recent changes (diff)', diffText);

  switch (category) {
    case 'dev': {
      addFile('package.json', 'package.json');
      addFile('.env.example', '.env.example');
      addFile('CONTRIBUTING.md', 'CONTRIBUTING.md');
      addFile('README.md', 'README.md');
      break;
    }
    case 'product': {
      // Try common product doc locations
      addFile('PRODUCT_PLAN.md', 'docs/PRODUCT_PLAN.md');
      addFile('README.md', 'README.md');
      const frontendApp = readDir('frontend/app') || readDir('src/app') || readDir('app/pages');
      if (frontendApp.length) {
        const routes = frontendApp.filter(f => !f.startsWith('.') && !f.startsWith('_'));
        addPart('Frontend routes (directories)', routes.join('\n'));
      }
      break;
    }
    case 'engineering': {
      // Try to find the main entry point
      for (const entry of ['src/index.js', 'src/index.ts', 'app/index.js', 'app/index.ts', 'index.js', 'index.ts']) {
        const content = readFile(entry);
        if (content) { addPart(`Entry point (${entry})`, content); break; }
      }
      addFile('package.json', 'package.json');
      break;
    }
    case 'interfaces': {
      // Try to find API route files
      for (const apiDir of ['src/api', 'app/api', 'src/routes', 'app/routes']) {
        const files = readDir(apiDir);
        for (const f of files.filter(f => f.endsWith('.js') || f.endsWith('.ts'))) {
          addFile(`API: ${f}`, `${apiDir}/${f}`);
        }
      }
      break;
    }
  }

  return parts.join('\n');
}

// -- Claude calls -------------------------------------------------------------

const SYSTEM_PROMPT = `You are a documentation reviewer. Given a code diff and source context, identify what documentation should be created or updated.

Rules:
- Only flag documentation needs you can justify from the provided context.
- Be specific: name the file, section, or concept that needs documenting.
- Categorize each item as NEW (new docs needed), UPDATE (existing docs are stale), or OK (no change needed).
- For each item needing work, write a 1-2 sentence description of what should be documented.
- Be concise. Bullet points, not prose.

Return ONLY valid JSON (no markdown fences):
{
  "items": [
    {
      "status": "NEW, UPDATE, or OK",
      "target": "docs/category/FILE.md -- Section Name",
      "description": "What needs to be documented and why"
    }
  ],
  "summary": "One sentence overall assessment"
}

The "status" field must be exactly one of: "NEW", "UPDATE", or "OK".`;

const CATEGORY_DESCRIPTIONS = {
  dev: 'Developer documentation: setup, testing, deployment, env vars, prerequisites',
  product: 'Product documentation: features, user flows, pricing tiers, onboarding',
  engineering: 'Engineering documentation: architecture, data model, request flow',
  interfaces: 'Interface documentation: API endpoints, SDK reference, tool definitions',
};

async function callClaude(category, context) {
  const userMsg = `Review the "${category}" documentation category.\n\nCategory scope: ${CATEGORY_DESCRIPTIONS[category]}\n\nIdentify what documentation needs to be created or updated based on this code change.\n\n## Source Context\n\n${context}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude ${res.status}: ${errText}`);
  }

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
  throw new Error(`Could not extract valid JSON: ${lastErr?.message}`);
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const commitSha = git('rev-parse HEAD').slice(0, 8) || 'unknown';
  console.log(`TLM Docs Agent -- commit ${commitSha}`);

  const { files: changedFiles, diffText } = getDiff();

  let categoriesToRun;

  if (CATEGORY === 'all') {
    categoriesToRun = ['dev', 'product', 'engineering', 'interfaces'];
    console.log('Manual dispatch: reviewing all categories');
  } else if (CATEGORY && CATEGORY !== 'auto') {
    categoriesToRun = [CATEGORY];
    console.log(`Manual dispatch: reviewing ${CATEGORY} only`);
  } else {
    if (!changedFiles.length) {
      console.log('No changed files detected -- skipping.');
      return;
    }

    console.log(`Changed files: ${changedFiles.length}`);
    if (changedFiles.length > 50) {
      console.log('Large diff (50+ files) -- reviewing all categories');
      categoriesToRun = ['dev', 'product', 'engineering', 'interfaces'];
    } else {
      categoriesToRun = classifyFiles(changedFiles);
    }

    if (!categoriesToRun.length) {
      console.log('No doc-relevant categories affected -- skipping.');
      return;
    }
  }

  console.log(`Categories: ${categoriesToRun.join(', ')}`);

  const results = {};

  for (const category of categoriesToRun) {
    console.log(`\n--- ${category} ---`);
    try {
      console.log('  Assembling context...');
      const context = assembleContext(category, diffText);
      console.log(`  Context: ${context.length} chars`);

      console.log('  Calling Claude...');
      const review = await callClaude(category, context);
      console.log(`  ${review.items?.length || 0} items, summary: ${review.summary}`);
      results[category] = review;
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      results[category] = { items: [], summary: `Error: ${err.message}` };
    }
  }

  const comment = formatComment(results, commitSha);
  if (comment) {
    writeFileSync('/tmp/tlm-docs-comment.md', comment);
    console.log(`\nWrote comment to /tmp/tlm-docs-comment.md (${comment.length} chars)`);
  } else {
    console.log('\nNo documentation updates needed.');
  }

  console.log('\nDone.');
}

function escapeTableCell(text) {
  return (text || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatComment(results, commitSha) {
  const sections = [];
  let hasWork = false;
  const errors = [];

  for (const [category, review] of Object.entries(results)) {
    if (review.summary?.startsWith('Error:')) {
      errors.push(`- **${category}**: ${review.summary}`);
      continue;
    }

    const actionItems = (review.items || []).filter(i => i.status !== 'OK');
    if (!actionItems.length) continue;
    hasWork = true;

    const lines = [`### ${category}`, ''];
    if (review.summary) lines.push(`${review.summary}`, '');

    lines.push('| Status | Target | Description |', '|--------|--------|-------------|');
    for (const item of actionItems) {
      const icon = item.status === 'NEW' ? '\uD83C\uDD95' : '\uD83D\uDCDD';
      lines.push(`| ${icon} ${item.status} | \`${escapeTableCell(item.target)}\` | ${escapeTableCell(item.description)} |`);
    }
    sections.push(lines.join('\n'));
  }

  if (!hasWork && !errors.length) return null;

  const parts = [
    '\uD83D\uDCDA **TLM Docs Review**',
    '',
    'The following documentation may need updating based on this commit:',
    '',
    ...sections,
  ];

  if (errors.length) {
    parts.push('', '### Errors', '', ...errors);
  }

  parts.push('', '---', `<sub>\uD83E\uDD16 TLM Docs \u00B7 [Claude ${MODEL}](https://anthropic.com) \u00B7 SHA: \`${commitSha}\`</sub>`);
  return parts.join('\n');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
