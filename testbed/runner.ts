/**
 * Automated Testbed Runner
 *
 * Reads queries from docs/testbed-standard-queries.md, sends each to the
 * dashboard API, polls until ready, downloads the resulting JSON, and saves
 * everything under test-results/.
 *
 * Usage:
 *   npx tsx testbed/runner.ts [--base-url http://localhost:3000] [--concurrency 2]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
interface Config {
  baseUrl: string
  apiKey: string
  concurrency: number
  pollIntervalMs: number
  timeoutMs: number
  cooldownMs: number
  outputDir: string
}

function parseArgs(): Config {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag)
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
  }
  // --resume: reuse the latest (or specified) results dir, skip already-succeeded cases
  const resumeArg = get('--resume', '')
  let outputDir: string
  if (resumeArg === 'latest' || args.includes('--resume') && !resumeArg) {
    // Find the latest results dir
    const resultsRoot = path.join(PROJECT_ROOT, 'testbed', 'results')
    const dirs = fs.existsSync(resultsRoot)
      ? fs.readdirSync(resultsRoot).filter((d) => fs.statSync(path.join(resultsRoot, d)).isDirectory() && d !== 'single-test').sort()
      : []
    outputDir = dirs.length > 0 ? path.join(resultsRoot, dirs[dirs.length - 1]) : path.join(resultsRoot, new Date().toISOString().replace(/[:.]/g, '-'))
  } else if (resumeArg) {
    outputDir = path.resolve(resumeArg)
  } else {
    outputDir = path.join(PROJECT_ROOT, 'testbed', 'results', new Date().toISOString().replace(/[:.]/g, '-'))
  }
  return {
    baseUrl: get('--base-url', 'http://localhost:3000'),
    apiKey: get('--api-key', 'test-api-key'),
    concurrency: parseInt(get('--concurrency', '1'), 10),
    pollIntervalMs: parseInt(get('--poll-interval', '3000'), 10),
    timeoutMs: parseInt(get('--timeout', '180000'), 10),
    cooldownMs: parseInt(get('--cooldown', '5000'), 10),
    outputDir,
  }
}

function testCaseSlug(tc: TestCase): string {
  return `${tc.category.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${tc.index}`
}

// ---------------------------------------------------------------------------
// Parse queries from the markdown catalog
// ---------------------------------------------------------------------------
interface TestCase {
  category: string
  index: number
  prompt: string
  expectedPromQL: string[]
}

function parseTestCases(mdPath: string): TestCase[] {
  const content = fs.readFileSync(mdPath, 'utf-8')
  const lines = content.split('\n')

  const cases: TestCase[] = []
  let currentCategory = ''
  let inPrompt = false
  let inPromQL = false
  let promptLines: string[] = []
  let expectedPromQL: string[] = []
  let currentPromQL = ''
  let categoryIndex = 0

  for (const line of lines) {
    // Category heading (## ...)
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      currentCategory = line.replace('## ', '').trim()
      categoryIndex = 0
      continue
    }

    // Prompt marker
    if (line.trim() === '### Prompt') {
      // Save previous test case if any
      if (promptLines.length > 0) {
        if (currentPromQL.trim()) {
          expectedPromQL.push(currentPromQL.trim())
          currentPromQL = ''
        }
        cases.push({
          category: currentCategory,
          index: categoryIndex,
          prompt: promptLines.join(' ').trim(),
          expectedPromQL: [...expectedPromQL],
        })
      }
      promptLines = []
      expectedPromQL = []
      currentPromQL = ''
      inPrompt = true
      inPromQL = false
      categoryIndex++
      continue
    }

    // Start of code block
    if (line.trim().startsWith('```promql')) {
      inPrompt = false
      if (currentPromQL.trim()) {
        expectedPromQL.push(currentPromQL.trim())
      }
      currentPromQL = ''
      inPromQL = true
      continue
    }

    // End of code block
    if (line.trim() === '```' && inPromQL) {
      inPromQL = false
      continue
    }

    if (inPromQL) {
      currentPromQL += line + '\n'
      continue
    }

    // "Expected PromQL:" marker
    if (line.trim().startsWith('Expected PromQL')) {
      inPrompt = false
      continue
    }

    if (inPrompt && line.trim()) {
      promptLines.push(line.trim())
    }
  }

  // Save the last test case
  if (promptLines.length > 0) {
    if (currentPromQL.trim()) {
      expectedPromQL.push(currentPromQL.trim())
    }
    cases.push({
      category: currentCategory,
      index: categoryIndex,
      prompt: promptLines.join(' ').trim(),
      expectedPromQL: [...expectedPromQL],
    })
  }

  return cases
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const headers = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'x-api-key': apiKey,
  'x-user-role': 'admin',
})

async function createDashboard(cfg: Config, prompt: string): Promise<{ id: string; status: string }> {
  const maxRetries = 5
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/api/dashboards`, {
      method: 'POST',
      headers: headers(cfg.apiKey),
      body: JSON.stringify({ prompt }),
    })
    if (res.status === 429) {
      const wait = Math.min(30000, (attempt + 1) * 10000)
      console.log(`    [429] Rate limited, waiting ${wait / 1000}s before retry...`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST /api/dashboards failed (${res.status}): ${text}`)
    }
    return res.json() as Promise<{ id: string; status: string }>
  }
  throw new Error('POST /api/dashboards failed: rate limited after max retries')
}

async function getDashboard(cfg: Config, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.baseUrl}/api/dashboards/${id}`, {
    headers: headers(cfg.apiKey),
  })
  if (!res.ok) {
    throw new Error(`GET /api/dashboards/${id} failed (${res.status})`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

async function pollUntilReady(cfg: Config, id: string): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < cfg.timeoutMs) {
    const dashboard = await getDashboard(cfg, id)
    const status = dashboard['status'] as string
    if (status === 'ready' || status === 'failed') {
      return dashboard
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs))
  }
  throw new Error(`Dashboard ${id} did not become ready within ${cfg.timeoutMs / 1000}s`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface TestResult {
  testCase: TestCase
  dashboardId: string
  status: string
  durationMs: number
  panelCount: number
  dashboard: Record<string, unknown>
  error?: string
}

function saveResult(cfg: Config, r: TestResult): void {
  if (!r.dashboardId) return
  const slug = testCaseSlug(r.testCase)
  const filePath = path.join(cfg.outputDir, 'dashboards', `${slug}.json`)
  fs.writeFileSync(filePath, JSON.stringify({
    testCase: {
      category: r.testCase.category,
      index: r.testCase.index,
      prompt: r.testCase.prompt,
      expectedPromQL: r.testCase.expectedPromQL,
    },
    result: {
      dashboardId: r.dashboardId,
      status: r.status,
      durationMs: r.durationMs,
      panelCount: r.panelCount,
    },
    dashboard: r.dashboard,
  }, null, 2))
}

async function runTestCase(cfg: Config, tc: TestCase): Promise<TestResult> {
  const start = Date.now()
  try {
    console.log(`  [START] ${tc.category} #${tc.index}: "${tc.prompt.slice(0, 60)}..."`)
    const created = await createDashboard(cfg, tc.prompt)
    const dashboard = await pollUntilReady(cfg, created.id)
    const durationMs = Date.now() - start
    const panels = (dashboard['panels'] as unknown[]) ?? []

    console.log(`  [DONE]  ${tc.category} #${tc.index}: ${dashboard['status']} — ${panels.length} panels in ${(durationMs / 1000).toFixed(1)}s`)

    const result: TestResult = {
      testCase: tc,
      dashboardId: created.id,
      status: dashboard['status'] as string,
      durationMs,
      panelCount: panels.length,
      dashboard,
    }
    saveResult(cfg, result)
    return result
  } catch (err) {
    const durationMs = Date.now() - start
    const message = err instanceof Error ? err.message : String(err)
    console.log(`  [ERROR] ${tc.category} #${tc.index}: ${message}`)
    return {
      testCase: tc,
      dashboardId: '',
      status: 'error',
      durationMs,
      panelCount: 0,
      dashboard: {},
      error: message,
    }
  }
}

async function runWithConcurrency(cfg: Config, cases: TestCase[]): Promise<TestResult[]> {
  const results: TestResult[] = []
  const queue = [...cases]

  async function worker() {
    while (queue.length > 0) {
      const tc = queue.shift()!
      const result = await runTestCase(cfg, tc)
      results.push(result)
      // Cooldown between test cases to avoid rate limiting
      if (queue.length > 0 && cfg.cooldownMs > 0) {
        await new Promise((r) => setTimeout(r, cfg.cooldownMs))
      }
    }
  }

  const workers = Array.from({ length: cfg.concurrency }, () => worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function generateReport(results: TestResult[]): string {
  const lines: string[] = ['# Testbed Run Report', '']

  const total = results.length
  const ready = results.filter((r) => r.status === 'ready').length
  const failed = results.filter((r) => r.status === 'failed').length
  const errors = results.filter((r) => r.status === 'error').length
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / total

  lines.push(`## Summary`)
  lines.push(`- **Total:** ${total}`)
  lines.push(`- **Ready:** ${ready}`)
  lines.push(`- **Failed:** ${failed}`)
  lines.push(`- **Errors:** ${errors}`)
  lines.push(`- **Avg Duration:** ${(avgDuration / 1000).toFixed(1)}s`)
  lines.push('')

  // Group by category
  const byCategory = new Map<string, TestResult[]>()
  for (const r of results) {
    const cat = r.testCase.category
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(r)
  }

  for (const [category, catResults] of byCategory) {
    lines.push(`## ${category}`)
    lines.push('')
    lines.push('| # | Prompt | Status | Panels | Duration | Expected PromQL |')
    lines.push('|---|--------|--------|--------|----------|-----------------|')

    for (const r of catResults) {
      const promptShort = r.testCase.prompt.slice(0, 50) + (r.testCase.prompt.length > 50 ? '...' : '')
      const statusIcon = r.status === 'ready' ? 'OK' : 'FAIL'
      lines.push(
        `| ${r.testCase.index} | ${promptShort} | ${statusIcon} | ${r.panelCount} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.testCase.expectedPromQL.length} |`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = parseArgs()
  const mdPath = path.join(PROJECT_ROOT, 'docs', 'testbed-standard-queries.md')

  if (!fs.existsSync(mdPath)) {
    console.error(`Testbed queries not found at ${mdPath}`)
    process.exit(1)
  }

  const cases = parseTestCases(mdPath)
  console.log(`Parsed ${cases.length} test cases from ${mdPath}`)
  console.log(`Output dir: ${cfg.outputDir}`)
  console.log(`Base URL: ${cfg.baseUrl}`)
  console.log(`Concurrency: ${cfg.concurrency}`)
  console.log('')

  // Check API is reachable
  try {
    const healthRes = await fetch(`${cfg.baseUrl}/api/dashboards`, { headers: headers(cfg.apiKey) })
    if (!healthRes.ok) {
      console.error(`API returned ${healthRes.status} — is the server running?`)
      process.exit(1)
    }
  } catch {
    console.error(`Cannot reach ${cfg.baseUrl} — is the server running?`)
    process.exit(1)
  }

  // Create output directory
  fs.mkdirSync(cfg.outputDir, { recursive: true })
  fs.mkdirSync(path.join(cfg.outputDir, 'dashboards'), { recursive: true })

  // Load existing successful results to skip
  const existingResults: TestResult[] = []
  const pendingCases: TestCase[] = []
  for (const tc of cases) {
    const slug = testCaseSlug(tc)
    const filePath = path.join(cfg.outputDir, 'dashboards', `${slug}.json`)
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (data.result?.status === 'ready') {
          console.log(`  [SKIP] ${tc.category} #${tc.index}: already succeeded`)
          existingResults.push({
            testCase: tc,
            dashboardId: data.result.dashboardId,
            status: data.result.status,
            durationMs: data.result.durationMs,
            panelCount: data.result.panelCount,
            dashboard: data.dashboard,
          })
          continue
        }
      } catch { /* re-run if file is corrupt */ }
    }
    pendingCases.push(tc)
  }

  if (pendingCases.length === 0) {
    console.log('\nAll test cases already have results. Nothing to do.')
    console.log(`Results at: ${cfg.outputDir}`)
    return
  }

  console.log(`\nRunning ${pendingCases.length} pending test cases (${existingResults.length} skipped)...\n`)
  const newResults = await runWithConcurrency(cfg, pendingCases)
  const results = [...existingResults, ...newResults]

  // Sort results back to original order
  results.sort((a, b) => {
    if (a.testCase.category !== b.testCase.category) return a.testCase.category.localeCompare(b.testCase.category)
    return a.testCase.index - b.testCase.index
  })

  // Save summary
  const summaryPath = path.join(cfg.outputDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(
    results.map((r) => ({
      category: r.testCase.category,
      index: r.testCase.index,
      prompt: r.testCase.prompt,
      expectedPromQLCount: r.testCase.expectedPromQL.length,
      dashboardId: r.dashboardId,
      status: r.status,
      panelCount: r.panelCount,
      durationMs: r.durationMs,
      error: r.error,
    })),
    null, 2,
  ))

  // Generate markdown report
  const report = generateReport(results)
  fs.writeFileSync(path.join(cfg.outputDir, 'report.md'), report)

  // Print summary
  console.log('\n' + '='.repeat(60))
  console.log(report)
  console.log('='.repeat(60))
  console.log(`\nResults saved to: ${cfg.outputDir}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
