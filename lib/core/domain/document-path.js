// Pure lexical locator rules, shared by admission and physical containment.
export const DOC_PATH_CODES = Object.freeze({
  security: 'security-rejected',
  outside: 'outside-root',
  missing: 'file-missing',
  permission: 'permission-denied',
  root: 'root-unavailable',
});

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DRIVE_PREFIX = /^[a-z]:/i;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function security(detail) {
  return { ok: false, availability: 'security_rejected', code: DOC_PATH_CODES.security, detail };
}

/** Lexical gate: returns segments, or a classified rejection. */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return security('empty-path');
  if (CONTROL_CHAR.test(relPath)) return security('control-character');
  if (relPath.includes('\\')) return security('backslash');
  if (relPath.startsWith('/')) return security('absolute-path');
  if (DRIVE_PREFIX.test(relPath)) return security('drive-prefix');
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') return security('empty-segment');
    if (segment === '.' || segment === '..') return security('dot-segment');
    if (segment.includes(':')) return security('ads-stream');
    if (/[ .]$/.test(segment)) return security('trailing-space-or-dot');
    if (DEVICE_NAME.test(segment)) return security('device-name');
  }
  return { ok: true, segments };
}
