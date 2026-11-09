import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { capabilityProposals, changeOptimization, digest, readOptimization, saveOptimization } from './optimize.mjs';
import { writeAtomic } from './store.mjs';

const KEYS = { collaboration: ['multi_agent'], goals: ['goals'], image_media: ['view_image'] };
const configPath = (repo, host) => join(repo.root, host === 'codex' ? '.codex/config.toml' : '.claude/settings.local.json');

function safePath(repo, file) {
  for (let path = file; path !== repo.root; path = dirname(path)) {
    if (!path.startsWith(`${repo.root}${sep}`)) throw new Error('configuration escapes the repository');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('refusing symlinked configuration');
  }
  const tracked = execFileSync('git', ['-C', repo.root, 'ls-files', '--', relative(repo.root, file)], { encoding: 'utf8', timeout: 2000 });
  if (tracked.trim()) throw new Error('refusing to change a tracked project configuration');
}

export function patchCodexCapabilities(text, names) {
  if (names.some((n) => !Object.hasOwn(KEYS, n))) throw new Error('unsupported Codex capability');
  const lines = text.split('\n');
  const headers = lines.flatMap((line, i) => (/^\s*\[features\]\s*(?:#.*)?$/.test(line) ? [i] : []));
  if (headers.length > 1 || /\[\s*["']features["']\s*\]|^\s*features\s*=/m.test(text)) throw new Error('ambiguous features table');
  const start = headers[0];
  const end = start === undefined ? lines.length : lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  const at = end < 0 ? lines.length : end;
  const body = start === undefined ? '' : lines.slice(start + 1, at).join('\n');
  const additions = [];
  for (const key of names.flatMap((n) => KEYS[n])) {
    if (new RegExp(`^\\s*["']?${key}["']?\\s*=`, 'm').test(body)) throw new Error(`preserve explicit ${key} setting; change it yourself`);
    additions.push(`${key} = false # limitcast optimizer`);
  }
  lines.splice(at, 0, ...(start === undefined ? ['', '[features]'] : []), ...additions);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function validateCodex(repo, disabled = []) {
  // `features list` ignores -C on Codex 0.167; its actual cwd decides which project config is loaded.
  const output = execFileSync('codex', ['features', 'list'], { cwd: repo.root, encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 });
  for (const key of Object.values(KEYS).flat()) {
    if (!new RegExp(`^${key}\\s+(?:stable|experimental|under development)\\s+(?:true|false)$`, 'm').test(output))
      throw new Error(`Codex does not expose supported ${key} control`);
  }
  for (const key of disabled.flatMap((name) => KEYS[name] ?? [])) {
    if (!new RegExp(`^${key}\\s+.*\\s+false$`, 'm').test(output)) throw new Error(`Codex ignored the project ${key} setting; check project trust`);
  }
}

export function applyCapabilities(repo, host, names, { validate = validateCodex } = {}) {
  if (!['claude', 'codex'].includes(host) || !names.length) throw new Error('choose proposed Claude tools or Codex capabilities');
  const file = configPath(repo, host);
  safePath(repo, file);
  if (host === 'codex') validate(repo);
  const result = changeOptimization(repo, (state) => {
    const proposal = capabilityProposals(state, host);
    if (names.some((n) => !proposal.includes(n))) throw new Error('selection is protected, used, or lacks evidence; preview again');
    if (state.applied?.[host]) throw new Error('restore the previous capability change before applying another');
    if (existsSync(file) && statSync(file).size > 100_000) throw new Error('project configuration exceeds safe editing limit');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    let after;
    if (host === 'codex') after = patchCodexCapabilities(before ?? '', names);
    else {
      const cfg = JSON.parse(before ?? '{}');
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('settings must be an object');
      if (cfg.permissions && (typeof cfg.permissions !== 'object' || Array.isArray(cfg.permissions))) throw new Error('invalid permissions');
      cfg.permissions ??= {};
      if (cfg.permissions.deny && !Array.isArray(cfg.permissions.deny)) throw new Error('invalid deny list');
      if ((cfg.permissions.deny ?? []).some((name) => typeof name !== 'string')) throw new Error('invalid deny-list entry');
      cfg.permissions.deny = [...new Set([...(cfg.permissions.deny ?? []), ...names])];
      after = `${JSON.stringify(cfg, null, 2)}\n`;
    }
    state.applied ??= {};
    state.applied[host] = { before, after: digest(after), names };
    // Journal before changing the host: a killed process still leaves enough evidence to restore.
    saveOptimization(repo, state);
    try {
      mkdirSync(dirname(file), { recursive: true });
      if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== before) throw new Error('configuration changed during apply');
      writeAtomic(file, after);
    } catch (error) {
      if (existsSync(file) && readFileSync(file, 'utf8') === after) {
        if (before === null) unlinkSync(file);
        else writeAtomic(file, before);
      }
      delete state.applied[host];
      saveOptimization(repo, state);
      throw error;
    }
    return { path: file, names, restart: true };
  });
  try {
    if (host === 'codex') validate(repo, names);
  } catch (error) {
    restoreCapabilities(repo, host, { protect: false });
    throw error;
  }
  return result;
}

export function restoreCapabilities(repo, host, { protect = true } = {}) {
  const file = configPath(repo, host);
  safePath(repo, file);
  return changeOptimization(repo, (state) => {
    const saved = state.applied?.[host];
    if (!saved) return { restored: false };
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === saved.before) {
      delete state.applied[host];
      return { restored: true, recovered: true };
    }
    if (current === null || digest(current) !== saved.after)
      throw new Error('configuration changed after apply; preserve your edits and reconcile manually');
    if (saved.before === null) unlinkSync(file);
    else writeAtomic(file, saved.before);
    delete state.applied[host];
    if (protect) state.config.keep = [...new Set([...state.config.keep, ...saved.names])];
    return { restored: true, protected: saved.names };
  });
}

export function capabilityStatus(repo, host) {
  const state = readOptimization(repo);
  if (host === 'codex') validateCodex(repo);
  return { host, proposed: capabilityProposals(state, host), applied: state.applied?.[host]?.names ?? [], keep: state.config.keep };
}
