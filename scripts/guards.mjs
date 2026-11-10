/**
 * Pure guards behind the maintenance scripts. They live here so the risky
 * decisions (what to delay and what to rewrite) can be tested
 * without spawning a CLI or touching a real installation.
 */

/**
 * Remove one `- insert:` list item with `id: project-board`, leaving sibling
 * items and the YAML structure intact. An uninstall that only matches the exact
 * two-line shape used to swallow a shared list's parent and silently drop
 * siblings that followed.
 */
export function removeProjectBoardInsert(text) {
  if (typeof text !== 'string' || text === '') return { text: text ?? '', removed: 0 };
  const lines = text.split('\n');
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^- insert:\s*$/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const items = [];
    let j = i + 1;
    while (j < lines.length && /^ {4}- /.test(lines[j])) {
      const item = [lines[j]];
      j += 1;
      while (j < lines.length && /^ {6}/.test(lines[j])) {
        item.push(lines[j]);
        j += 1;
      }
      items.push(item.join('\n'));
    }
    const kept = items.filter((item) => !/^ {4}- id: project-board\s*$/m.test(item));
    if (kept.length === items.length) {
      out.push(lines[i]);
      continue;
    }
    removed += items.length - kept.length;
    if (kept.length > 0) {
      out.push(lines[i]);
      for (const item of kept) out.push(...item.split('\n'));
    }
    i = j - 1;
  }
  return { text: out.join('\n'), removed };
}

/** Keep read-only fixture confinement across Node's permission-flag rename. */
export function nodePermissionFlag(allowed = process.allowedNodeEnvironmentFlags) {
  for (const flag of ['--permission', '--experimental-permission']) {
    if (allowed.has(flag)) return flag;
  }
  throw new Error('This Node runtime exposes no supported permission flag; refusing to run an unconfined read-only fixture.');
}

/**
 * setTimeout(NaN) fires immediately, so an unparsable delay used to turn
 * `restart-later 5m` into a surprise restart. Fall back to the default instead.
 */
export function parseDelaySeconds(raw, fallback = 60, minimum = 5) {
  const requested = raw === undefined || raw === null || raw === '' ? null : raw;
  const value = requested === null ? fallback : Number(requested);
  const valid = Number.isFinite(value) && value > 0;
  return { seconds: Math.max(minimum, valid ? value : fallback), valid, requested };
}

/**
 * `git worktree remove` deletes ignored files too (.env, build output) while
 * `git status --porcelain` reports a clean tree. Refuse unless --force.
 */
export function removalGuard(ignored, force = false) {
  const list = Array.isArray(ignored) ? ignored.map((entry) => String(entry).trim()).filter(Boolean) : [];
  const blocking = list.filter((entry) => {
    const clean = entry.replace(/\/+$/, '');
    return clean !== 'node_modules' && !clean.startsWith('node_modules/');
  });
  if (blocking.length === 0) return { ok: true, blocking, message: null };
  if (force) return { ok: true, blocking, message: blocking.length + ' ignored path(s) will be deleted (--force)' };
  return {
    ok: false,
    blocking,
    message: 'worktree has ignored files that removal would delete:' + '\n  ' + blocking.join('\n  ') + '\nre-run with --force if that is intended',
  };
}
