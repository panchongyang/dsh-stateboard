/**
 * Gate orchestration and human/JSON reporting.
 */
import path from 'node:path';
import { parse, toRel, typeScript, walk } from './ast.mjs';
import { checkLibFile } from './lib-rules.mjs';
import { checkScriptFile } from './script-rules.mjs';
import {
  REPO_ROOT, RULES, SCRIPT_MODULES, SCRIPT_POLICY, layerOf,
} from './config.mjs';

export { REPO_ROOT, RULES, SCRIPT_MODULES, SCRIPT_POLICY, layerOf };

function parseErrors(ts, sourceFile) {
  return (sourceFile.parseDiagnostics || []).slice(0, 1);
}

function reportParseError(ts, sourceFile, report, rel, sourceFileForLine) {
  const diagnostic = parseErrors(ts, sourceFile)[0];
  if (!diagnostic) return false;
  const line = diagnostic.start === undefined
    ? 1
    : sourceFileForLine.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  report(rel)(RULES.parseError, line, 'cannot parse: ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  return true;
}

export function checkBackendLayers(options = {}) {
  const ts = typeScript();
  const root = path.resolve(options.root || REPO_ROOT);
  const customPolicy = Boolean(options.scriptPolicy);
  const policy = options.scriptPolicy || SCRIPT_POLICY;
  const violations = [];
  const layers = {};
  const seen = new Set();
  const report = (file) => (rule, line, message, explicitFile) => {
    const finalFile = explicitFile || file;
    const key = finalFile + ':' + line + ':' + rule + ':' + message;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file: finalFile, line, rule, message });
  };

  let libFiles = [];
  if (!options.onlyScripts) {
    libFiles = walk(path.join(root, 'lib')).sort();
    for (const file of libFiles) {
      const rel = toRel(root, file);
      if (rel === 'lib/client.js') continue;
      const { sourceFile } = parse(ts, file);
      if (reportParseError(ts, sourceFile, report, rel, sourceFile)) continue;
      const result = checkLibFile(ts, root, file, sourceFile, report(rel));
      layers[result.layer] = (layers[result.layer] || 0) + 1;
    }
  }

  let scriptFiles = [];
  const scriptResults = [];
  if (!options.onlyLib) {
    scriptFiles = walk(path.join(root, 'scripts'))
      .filter((file) => path.dirname(file) === path.join(root, 'scripts'))
      .sort();
    for (const file of scriptFiles) {
      const rel = toRel(root, file);
      const entry = policy[rel];
      if (!entry) {
        report(rel)(RULES.unclassifiedScript, 1, 'maintenance script is not classified in SCRIPT_POLICY');
        scriptResults.push({ file: rel, modes: [], boardWrites: 0, fsWrites: 0, privateWrites: 0 });
        continue;
      }
      const { source, sourceFile } = parse(ts, file);
      if (reportParseError(ts, sourceFile, report, rel, sourceFile)) continue;
      scriptResults.push(checkScriptFile(ts, rel, sourceFile, source, entry, report(rel)));
    }
    for (const rel of Object.keys(policy)) {
      if (!scriptFiles.some((file) => toRel(root, file) === rel)) {
        report(rel)(RULES.staleScriptEntry, 1, 'SCRIPT_POLICY entry has no matching scripts/*.mjs file');
      }
    }
  }

  let moduleFiles = [];
  const moduleResults = [];
  if (!options.onlyLib && !customPolicy) {
    const moduleRoot = path.join(root, 'scripts', 'backend-layers');
    moduleFiles = walk(moduleRoot).sort();
    for (const file of moduleFiles) {
      const rel = toRel(root, file);
      const entry = SCRIPT_MODULES[rel];
      if (!entry) {
        report(rel)(RULES.unclassifiedModule, 1, 'backend-layers support module is not classified in SCRIPT_MODULES');
        continue;
      }
      const { source, sourceFile } = parse(ts, file);
      if (reportParseError(ts, sourceFile, report, rel, sourceFile)) continue;
      moduleResults.push(checkScriptFile(ts, rel, sourceFile, source, entry, report(rel)));
    }
    for (const rel of Object.keys(SCRIPT_MODULES)) {
      if (!moduleFiles.some((file) => toRel(root, file) === rel)) {
        report(rel)(RULES.staleScriptEntry, 1, 'SCRIPT_MODULES entry has no matching scripts/backend-layers file');
      }
    }
  }

  const ruleCounts = {};
  for (const violation of violations) ruleCounts[violation.rule] = (ruleCounts[violation.rule] || 0) + 1;
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));

  return {
    ok: violations.length === 0,
    root,
    files: { lib: libFiles.length, scripts: scriptFiles.length, modules: moduleFiles.length },
    layers,
    rules: ruleCounts,
    scripts: {
      classified: scriptResults.filter((row) => row.modes.length > 0).length,
      unclassified: scriptResults.filter((row) => row.modes.length === 0).map((row) => row.file),
      rows: scriptResults,
      modules: moduleResults,
    },
    violations,
  };
}

export function printHuman(result) {
  const layerText = Object.entries(result.layers).sort(([a], [b]) => a.localeCompare(b))
    .map(([layer, count]) => layer + '=' + count).join(' ');
  console.log('[backend-layers] lib=' + result.files.lib + ' scripts=' + result.files.scripts
    + ' modules=' + result.files.modules + ' classified=' + result.scripts.classified
    + ' violations=' + result.violations.length);
  if (layerText) console.log('[backend-layers] layers: ' + layerText);
  const rules = Object.entries(result.rules).sort(([a], [b]) => a.localeCompare(b));
  if (rules.length) console.log('[backend-layers] rules: ' + rules.map(([rule, count]) => rule + '=' + count).join(' '));
  for (const violation of result.violations) {
    console.log('  ' + violation.file + ':' + violation.line + ' [' + violation.rule + '] ' + violation.message);
  }
  if (result.violations.length) {
    console.log('[backend-layers] HARD FAILURE: ' + result.violations.length
      + ' structural violation(s); fix the listed file/line or revert. No directory exemption, baseline waiver or green-by-exclusion is accepted.');
  }
}
