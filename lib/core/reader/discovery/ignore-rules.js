// Git ignore matching for workspace document projection.
//
// Pure functions only: no fs, no path, no environment. The scanner owns file
// reads, realpath containment and the "do not descend into an ignored parent"
// rule. This module answers one question per candidate path: does the last
// matching ignore rule in effect exclude it? Ancestors are the scanner's
// business, so a path below an ignored directory is reported as not ignored
// here; the scanner never asks, because it stops at the parent.
//
// Matching is iterative dynamic programming over pattern tokens and path
// segments: no RegExp and no recursive backtracking, so a hostile pattern
// cannot trigger catastrophic backtracking. Every input is bounded and every
// malformed or over-budget input fails closed with IgnoreError instead of
// guessing (a wrong "not ignored" would project files the repository excludes).

/** Hard ceilings. They bound compile and match work; exceeding one is an error. */
export const IGNORE_LIMITS = Object.freeze({
  textBytes: 65536,
  rules: 256,
  patternChars: 4096,
  patternBytes: 16384,
  ruleSegments: 128,
  baseSegments: 64,
  pathChars: 4096,
  pathSegments: 256,
  matchSteps: 4000000,
});

/** Fail-closed error for unparsable, unsafe or over-budget ignore input. */
export class IgnoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IgnoreError';
    this.code = code;
    if (details.line !== undefined) this.line = details.line;
  }
}

const encoder = new TextEncoder();
const compiledRule = new WeakSet();
// Matching is byte-oriented like Git (wildmatch): UTF-8 bytes, ASCII POSIX classes.
const BYTE = Object.freeze({ backslash: 92, slash: 47, star: 42, question: 63,
  openBracket: 91, closeBracket: 93, bang: 33, caret: 94, colon: 58, dash: 45 });

/**
 * Compile ignore-file text (one .gitignore worth of lines) into immutable rules.
 * @param {string} text raw ignore file text
 * @param {string} [baseRelPath] directory of the ignore file relative to the scan root
 * @returns {readonly object[]} frozen rule list for isIgnored
 */
export function compileIgnore(text, baseRelPath = '') {
  if (typeof text !== 'string') throw invalid('ignore text must be a string');
  if (encoder.encode(text).length > IGNORE_LIMITS.textBytes) {
    throw new IgnoreError('ignore-oversize', 'ignore text exceeds ' + IGNORE_LIMITS.textBytes + ' bytes');
  }
  const base = parseBase(baseRelPath);
  const rules = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    let source = lines[index];
    if (source.endsWith('\r')) source = source.slice(0, -1);
    if (source.includes('\0')) throw invalid('ignore pattern contains NUL', line);
    source = trimTrailingSpaces(source);
    if (source === '' || source.startsWith('#')) continue;
    const rule = compileLine(source, base, line);
    compiledRule.add(rule);
    rules.push(rule);
    if (rules.length > IGNORE_LIMITS.rules) {
      throw new IgnoreError('ignore-oversize', 'ignore file exceeds ' + IGNORE_LIMITS.rules + ' rules', { line });
    }
  }
  return Object.freeze(rules);
}

/**
 * Decide whether the last matching rule excludes relPath.
 * Inputs are validated strictly: relative POSIX path, no '.', '..', empty
 * segments or backslashes. Directory-only rules apply only to isDirectory.
 * @param {readonly object[]} rules value returned by compileIgnore
 * @param {string} relPath POSIX path relative to the scan root
 * @param {boolean} isDirectory whether relPath names a directory
 * @returns {boolean}
 */
export function isIgnored(rules, relPath, isDirectory) {
  if (!Array.isArray(rules)) throw invalid('rules must be an array of compiled ignore rules');
  if (typeof isDirectory !== 'boolean') throw invalid('isDirectory must be a boolean');
  const segments = parseRelPath(relPath);
  const byteSegments = segments.map((segment) => encoder.encode(segment));
  const budget = { steps: 0 };
  let ignored = false;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!compiledRule.has(rule)) throw invalid('rules must come from compileIgnore');
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.baseSegments.length >= segments.length) continue;
    if (!prefixMatches(rule.baseSegments, segments)) continue;
    if (matchRule(rule, byteSegments, budget)) ignored = !rule.negative;
  }
  return ignored;
}

// ---- parse -----------------------------------------------------------------

function invalid(message, line) {
  return new IgnoreError('ignore-invalid', message, line === undefined ? {} : { line });
}

function trimTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0;
    for (let cursor = end - 2; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function parseBase(baseRelPath) {
  if (typeof baseRelPath !== 'string') throw invalid('baseRelPath must be a string');
  if (baseRelPath === '') return Object.freeze([]);
  if (baseRelPath.includes('\0') || baseRelPath.includes('\\')) throw invalid('baseRelPath must be a POSIX relative path');
  if (baseRelPath.startsWith('/') || baseRelPath.endsWith('/')) throw invalid('baseRelPath must not start or end with a slash');
  const segments = baseRelPath.split('/');
  if (segments.length > IGNORE_LIMITS.baseSegments) {
    throw new IgnoreError('ignore-oversize', 'baseRelPath exceeds ' + IGNORE_LIMITS.baseSegments + ' segments');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw invalid('baseRelPath must not contain empty, "." or ".." segments');
  }
  return Object.freeze(segments);
}

function compileLine(source, baseSegments, line) {
  let text = source;
  let negative = false;
  if (text.startsWith('!')) {
    negative = true;
    text = text.slice(1);
    if (text === '') throw invalid('negation without a pattern', line);
  }
  if (text.length > IGNORE_LIMITS.patternChars) {
    throw new IgnoreError('ignore-oversize', 'ignore pattern exceeds ' + IGNORE_LIMITS.patternChars + ' characters', { line });
  }
  let directoryOnly = false;
  let anchored = false;
  if (text.endsWith('/')) {
    if (escapedAt(text, text.length - 1)) throw invalid('escaped slash cannot appear in an ignore pattern', line);
    directoryOnly = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('/')) {
    anchored = true;
    text = text.slice(1);
  }
  if (text === '') throw invalid('ignore pattern is empty after removing slashes', line);
  const segments = parseSegments(text, line);
  if (segments.length > IGNORE_LIMITS.ruleSegments) {
    throw new IgnoreError('ignore-oversize', 'ignore pattern exceeds ' + IGNORE_LIMITS.ruleSegments + ' segments', { line });
  }
  return Object.freeze({
    negative,
    directoryOnly,
    anchored,
    basename: !anchored && segments.length === 1,
    baseSegments,
    segments: Object.freeze(segments.map((tokens) => Object.freeze(tokens))),
    source,
    line,
  });
}

function escapedAt(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function parseSegments(text, line) {
  const points = Array.from(encoder.encode(text));
  if (points.length > IGNORE_LIMITS.patternBytes) {
    throw new IgnoreError('ignore-oversize', 'ignore pattern exceeds ' + IGNORE_LIMITS.patternBytes + ' bytes', { line });
  }
  const segments = [];
  let tokens = [];
  let started = false;
  let index = 0;
  while (index < points.length) {
    const byte = points[index];
    if (byte === BYTE.backslash) {
      if (index + 1 >= points.length) throw invalid('trailing escape', line);
      const escaped = points[index + 1];
      if (escaped === BYTE.slash) throw invalid('escaped slash cannot appear in an ignore pattern', line);
      tokens.push({ t: 'lit', c: escaped });
      started = true;
      index += 2;
      continue;
    }
    if (byte === BYTE.slash) {
      if (!started) throw invalid('empty path segment', line);
      segments.push(tokens);
      tokens = [];
      started = false;
      index += 1;
      continue;
    }
    if (byte === BYTE.star) {
      let run = 1;
      while (index + run < points.length && points[index + run] === BYTE.star) run += 1;
      tokens.push({ t: 'star', run });
      started = true;
      index += run;
      continue;
    }
    if (byte === BYTE.question) {
      tokens.push({ t: 'any' });
      started = true;
      index += 1;
      continue;
    }
    if (byte === BYTE.openBracket) {
      const parsed = parseClass(points, index, line);
      tokens.push(parsed.token);
      started = true;
      index = parsed.next;
      continue;
    }
    tokens.push({ t: 'lit', c: byte });
    started = true;
    index += 1;
  }
  if (started) segments.push(tokens);
  if (points.length > 0 && points[points.length - 1] === BYTE.slash) throw invalid('empty path segment', line);
  return segments.map((segment) => {
    if (segment.length === 1 && segment[0].t === 'star' && segment[0].run === 2) return Object.freeze([{ t: 'globstar' }]);
    return segment;
  });
}

// ASCII POSIX classes, exactly the set Git's wildmatch understands; anything else fails closed.
const POSIX_CLASSES = Object.freeze({
  alnum: [[48, 57], [65, 90], [97, 122]],
  alpha: [[65, 90], [97, 122]],
  blank: [[9, 9], [32, 32]],
  cntrl: [[0, 31], [127, 127]],
  digit: [[48, 57]],
  graph: [[33, 126]],
  lower: [[97, 122]],
  print: [[32, 126]],
  punct: [[33, 47], [58, 64], [91, 96], [123, 126]],
  space: [[9, 13], [32, 32]],
  upper: [[65, 90]],
  xdigit: [[48, 57], [65, 70], [97, 102]],
});

function parsePosixClass(points, start, line) {
  let index = start + 2;
  const nameStart = index;
  while (index < points.length && !(points[index] === BYTE.colon && points[index + 1] === BYTE.closeBracket)) index += 1;
  if (index >= points.length) throw invalid('unterminated POSIX character class', line);
  if (index === nameStart) throw invalid('empty POSIX character class', line);
  let name = '';
  for (let cursor = nameStart; cursor < index; cursor += 1) {
    if (points[cursor] < 0x21 || points[cursor] > 0x7e) throw invalid('unsupported POSIX character class', line);
    name += String.fromCharCode(points[cursor]);
  }
  const ranges = POSIX_CLASSES[name];
  if (!ranges) throw invalid('unsupported POSIX character class: ' + name, line);
  return { ranges, next: index + 2 };
}

function parseClass(points, start, line) {
  let index = start + 1;
  let negated = false;
  if (index < points.length && (points[index] === BYTE.bang || points[index] === BYTE.caret)) {
    negated = true;
    index += 1;
  }
  const ranges = [];
  let closed = false;
  while (index < points.length) {
    if (points[index] === BYTE.closeBracket && ranges.length > 0) {
      closed = true;
      index += 1;
      break;
    }
    if (points[index] === BYTE.openBracket && points[index + 1] === BYTE.colon) {
      const posix = parsePosixClass(points, index, line);
      ranges.push(...posix.ranges);
      index = posix.next;
      continue;
    }
    const low = readClassByte(points, index, line);
    index = low.next;
    let high = low.value;
    if (index < points.length && points[index] === BYTE.dash && index + 1 < points.length && points[index + 1] !== BYTE.closeBracket) {
      const upper = readClassByte(points, index + 1, line);
      index = upper.next;
      if (upper.value < low.value) throw invalid('reversed character range', line);
      high = upper.value;
    }
    ranges.push([low.value, high]);
  }
  if (!closed) throw invalid('unterminated character class', line);
  return { token: { t: 'class', negated, ranges }, next: index };
}

function readClassByte(points, index, line) {
  if (points[index] === BYTE.backslash) {
    if (index + 1 >= points.length) throw invalid('trailing escape in character class', line);
    return { value: points[index + 1], next: index + 2 };
  }
  return { value: points[index], next: index + 1 };
}

// ---- match -----------------------------------------------------------------

function parseRelPath(relPath) {
  if (typeof relPath !== 'string') throw invalid('relPath must be a string');
  if (relPath === '') throw invalid('relPath must not be empty');
  if (relPath.length > IGNORE_LIMITS.pathChars) {
    throw new IgnoreError('ignore-oversize', 'relPath exceeds ' + IGNORE_LIMITS.pathChars + ' characters');
  }
  if (relPath.includes('\0') || relPath.includes('\\')) throw invalid('relPath must be a POSIX relative path');
  if (relPath.startsWith('/') || relPath.endsWith('/')) throw invalid('relPath must not start or end with a slash');
  const segments = relPath.split('/');
  if (segments.length > IGNORE_LIMITS.pathSegments) {
    throw new IgnoreError('ignore-oversize', 'relPath exceeds ' + IGNORE_LIMITS.pathSegments + ' segments');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw invalid('relPath must not contain empty, "." or ".." segments');
  }
  return segments;
}

function prefixMatches(baseSegments, segments) {
  for (let index = 0; index < baseSegments.length; index += 1) {
    if (baseSegments[index] !== segments[index]) return false;
  }
  return true;
}

function matchRule(rule, byteSegments, budget) {
  const points = byteSegments.slice(rule.baseSegments.length);
  if (rule.basename) {
    const tokens = rule.segments[0];
    if (tokens.length === 1 && (tokens[0].t === 'star' || tokens[0].t === 'globstar')) return true;
    return matchSegment(tokens, points[points.length - 1], budget);
  }
  return matchPath(rule.segments, points, budget);
}

function matchPath(pattern, points, budget) {
  const count = points.length;
  let previous = new Uint8Array(count + 1);
  previous[0] = 1;
  for (let index = 0; index < pattern.length; index += 1) {
    const tokens = pattern[index];
    const current = new Uint8Array(count + 1);
    if (tokens.length === 1 && tokens[0].t === 'globstar') {
      let reachable = 0;
      for (let position = 0; position <= count; position += 1) {
        charge(budget);
        reachable |= previous[position];
        current[position] = reachable;
      }
      if (index === pattern.length - 1) return current[count - 1] === 1;
    } else {
      for (let position = 1; position <= count; position += 1) {
        charge(budget);
        if (previous[position - 1] === 1 && matchSegment(tokens, points[position - 1], budget)) {
          current[position] = 1;
        }
      }
    }
    previous = current;
  }
  return previous[count] === 1;
}

function matchSegment(tokens, points, budget) {
  const count = points.length;
  let previous = new Uint8Array(count + 1);
  previous[0] = 1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const current = new Uint8Array(count + 1);
    if (token.t === 'star') {
      for (let position = 0; position <= count; position += 1) {
        charge(budget);
        const reaches = previous[position] === 1 || (position > 0 && current[position - 1] === 1);
        current[position] = reaches ? 1 : 0;
      }
    } else {
      for (let position = 1; position <= count; position += 1) {
        charge(budget);
        if (previous[position - 1] === 1 && tokenMatches(token, points[position - 1])) current[position] = 1;
      }
    }
    previous = current;
  }
  return previous[count] === 1;
}

function tokenMatches(token, point) {
  if (token.t === 'any') return true;
  if (token.t === 'lit') return token.c === point;
  let inside = false;
  for (const [low, high] of token.ranges) {
    if (point >= low && point <= high) { inside = true; break; }
  }
  return inside !== token.negated;
}

function charge(budget) {
  budget.steps += 1;
  if (budget.steps > IGNORE_LIMITS.matchSteps) {
    throw new IgnoreError('ignore-budget', 'ignore matching exceeded ' + IGNORE_LIMITS.matchSteps + ' steps');
  }
}
