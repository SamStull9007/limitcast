// @ts-check

/** Every option the CLI reads. test/flags.test.mjs keeps this list in step with bin/limitcast.mjs. */
export const KNOWN_FLAGS = [
  '--alerts',
  '--apply',
  '--codex',
  '--copilot',
  '--pi',
  '--days',
  '--detach',
  '--fix',
  '--grok',
  '--guard',
  '--help',
  '--hook',
  '--html',
  '--jobs',
  '--json',
  '--no-open',
  '--out',
  '--optimize',
  '--refresh',
  '--remove',
  '--share',
  '--src',
  '--undo',
  '--why',
  '--window',
  '--yes',
];

/**
 * The first mistyped --option before any `--` separator, or undefined. Without this a typo such as
 * `install --gaurd` runs the plain command and looks like it worked.
 * @param {string[]} args
 */
export function unknownFlag(args) {
  const sep = args.indexOf('--');
  return (sep < 0 ? args : args.slice(0, sep)).find((a) => a.startsWith('--') && !KNOWN_FLAGS.includes(a));
}
