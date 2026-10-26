// @ts-check

/**
 * The Markdown reports for a person at a terminal: headings and **bold** in bold, markers gone.
 * Piped or written to a file, the Markdown is left as is. NO_COLOR drops the styling, not the cleanup.
 * @param {string} md
 * @param {{tty?: boolean, color?: boolean}} [o]
 */
export function forTerminal(md, { tty = process.stdout.isTTY === true, color = !process.env.NO_COLOR } = {}) {
  if (!tty) return md;
  const b = color ? (/** @type {string} */ s) => `\x1b[1m${s}\x1b[22m` : (/** @type {string} */ s) => s;
  return md.replace(/^#{1,6} (.+)$/gm, (_, h) => b(h)).replace(/\*\*(.+?)\*\*/g, (_, s) => b(s));
}
