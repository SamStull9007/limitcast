import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostCommand } from '../src/platform.mjs';

const required = [
  'lint',
  'security',
  ...['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap((os) => [22, 24, 26].map((node) => `test (${os}, ${node})`)),
];

export function validateRelease(run, sha) {
  if (!run || run.headSha !== sha || run.status !== 'completed' || run.conclusion !== 'success')
    throw new Error('Publication requires successful push CI for the exact release commit.');
  if (!Array.isArray(run.jobs) || required.some((name) => !run.jobs.some((job) => job.name === name && job.conclusion === 'success')))
    throw new Error('Publication requires lint, security and all nine test/package-smoke jobs.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const run = (cmd, args) =>
      execFileSync(...hostCommand(cmd, args), { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (run('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Publication requires a clean checkout.');
    const sha = run('git', ['rev-parse', 'HEAD']);
    const [latest] = JSON.parse(
      run('gh', ['run', 'list', '--workflow', 'ci.yml', '--commit', sha, '--event', 'push', '--limit', '1', '--json', 'databaseId']),
    );
    if (!latest) throw new Error('No push CI run exists for this release commit.');
    const ci = JSON.parse(run('gh', ['run', 'view', String(latest.databaseId), '--json', 'headSha,status,conclusion,jobs']));
    validateRelease(ci, sha);
    console.log(`Release preflight passed for ${sha}: all ${required.length} CI jobs succeeded.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message.split('\n')[0] : 'Release preflight failed.');
    process.exitCode = 1;
  }
}
