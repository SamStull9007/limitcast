// Bounded, read-only component comparison. Requires a separate pinned TokenEconomizer checkout and signed-in Codex.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callOptimizationModel } from '../src/model-optimize.mjs';

const upstream = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
const sha = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(sha, '264e7a7f32f0112a06aa83a97b9c2c4681563968', 're-review upstream before changing the comparison');
const report = {
  upstream: sha,
  model: 'gpt-5.6-luna',
  scope:
    'Process-judge component only; not end-to-end coding tasks, financial cost or universal superiority. One repeat; shared model, sequential calls, tools disabled.',
  results: [],
};
const trace = (changing = false, productive = false, explore = false) =>
  Array.from({ length: 30 }, (_, i) => ({
    action: explore ? 'other' : i % 2 ? 'check' : 'edit',
    command: !explore && i % 2 ? 'node --test' : null,
    failed: !explore && !productive && Boolean(i % 2),
    succeeded: productive && Boolean(i % 2),
    file: explore ? '' : 'a'.repeat(16),
    failure: productive || explore ? '' : changing ? i.toString(16).padStart(20, '0') : 'b'.repeat(20),
  }));
const cases = [
  { name: 'repeated-dead-end', expected: true, evidence: { calls: 60, errors: 30, repeats: 29, green: false, trace: trace() } },
  { name: 'productive-checks', expected: false, evidence: { calls: 60, errors: 0, repeats: 0, green: true, trace: trace(false, true) } },
  { name: 'changing-failures', expected: false, evidence: { calls: 60, errors: 30, repeats: 0, green: false, trace: trace(true) } },
  { name: 'read-only-exploration', expected: false, evidence: { calls: 60, errors: 0, repeats: 0, green: false, trace: trace(false, false, true) } },
  {
    name: 'recovered-after-failure',
    expected: false,
    evidence: { calls: 60, errors: 0, repeats: 0, green: true, trace: [...trace().slice(0, 20), ...trace(false, true).slice(20)] },
  },
  { name: 'insufficient-evidence', expected: false, evidence: { calls: 2, errors: 1, repeats: 0, green: false, trace: trace().slice(0, 2) } },
];
const python = `import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom tokeneconomizer.loopguard.judge import llm_stuck_judge\nbox=[]\ndef runner(prompt, model):\n box.append(prompt); return '{}',0\nllm_stuck_judge(sys.stdin.read(),runner)\nprint(json.dumps(box[0]))`;
assert.ok(cases.find((f) => f.name === 'read-only-exploration').evidence.trace.every((e) => e.action === 'other' && !e.failed && !e.command));
for (const fixture of cases.filter((f) => !process.argv[4] || f.name === process.argv[4])) {
  for (const product of ['Limitcast', 'TokenEconomizer']) {
    const start = Date.now();
    let result;
    try {
      if (product === 'Limitcast') result = callOptimizationModel({ kind: 'judge', evidence: fixture.evidence });
      else {
        const prompt = JSON.parse(execFileSync('python3', ['-c', python, upstream], { input: JSON.stringify(fixture.evidence), encoding: 'utf8' }));
        const dir = mkdtempSync(join(tmpdir(), 'lc-compare-'));
        try {
          const raw = execFileSync(
            'codex',
            [
              'exec',
              '--ignore-user-config',
              '--ignore-rules',
              '--ephemeral',
              '--skip-git-repo-check',
              '-s',
              'read-only',
              '--json',
              '--disable',
              'hooks',
              '--disable',
              'plugins',
              '--disable',
              'shell_tool',
              '--disable',
              'unified_exec',
              '--disable',
              'multi_agent',
              '-c',
              'web_search="disabled"',
              '-c',
              'project_doc_max_bytes=0',
              '-c',
              'model_reasoning_effort="low"',
              '-m',
              report.model,
              '-',
            ],
            {
              cwd: dir,
              input: prompt,
              encoding: 'utf8',
              timeout: 45000,
              maxBuffer: 256000,
              stdio: ['pipe', 'pipe', 'ignore'],
              env: { ...process.env, LIMITCAST_ALLOW: '1', LIMITCAST_MODEL_WORKER: '1' },
            },
          );
          const events = raw
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          const text = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
          result = { verdict: JSON.parse(text), usage: events.find((e) => e.type === 'turn.completed')?.usage ?? null };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      report.results.push({
        case: fixture.name,
        product,
        expected: fixture.expected,
        pass: result.verdict.stuck === fixture.expected,
        verdict: result.verdict,
        usage: result.usage,
        elapsedMs: Date.now() - start,
      });
    } catch {
      report.results.push({
        case: fixture.name,
        product,
        expected: fixture.expected,
        pass: false,
        error: 'native call or parsing failed',
        usage: null,
        elapsedMs: Date.now() - start,
      });
    }
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${product}: ${fixture.name}: ${report.results.at(-1).pass ? 'PASS' : 'FAIL'}`);
  }
}
