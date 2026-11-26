/**
 * Backend six-layer gate: path classification, import direction and the
 * maintenance-script inventory. This module holds data only; rules live in
 * lib-rules.mjs, script-rules.mjs and capabilities.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RULES = Object.freeze({
  forbiddenImport: 'forbidden-import',
  unknownLayer: 'unknown-layer',
  stateWrite: 'state-write',
  publishedMutation: 'published-mutation',
  writeBypass: 'write-bypass',
  hostCapability: 'host-capability',
  capabilityAlias: 'capability-alias',
  dynamicCall: 'dynamic-call',
  dynamicImport: 'dynamic-import',
  queryWrite: 'query-write',
  rawWrite: 'raw-write',
  rawWriteAlias: 'raw-write-alias',
  eventAssembly: 'event-assembly',
  commandImport: 'command-import',
  commandSurface: 'command-surface',
  commandWriteFunction: 'command-write-function',
  commandPlanCallback: 'command-plan-callback',
  modelCommandCallback: 'model-command-callback',
  preCommandActivity: 'pre-command-activity',
  operationsCommandName: 'operations-command-name',
  layerIo: 'layer-io',
  ambientTime: 'ambient-time',
  parseError: 'parse-error',
  unclassifiedScript: 'unclassified-script',
  unclassifiedModule: 'unclassified-module',
  staleScriptEntry: 'stale-script-entry',
  scriptReadWriter: 'script-read-writer',
  scriptDryRunWriter: 'script-dry-run-writer',
  scriptMissingGate: 'script-missing-gate',
  scriptPrivateWrite: 'script-private-write',
  scriptFsWrite: 'script-fs-write',
});

/**
 * Directory -> layer. Order matters: the first matching prefix wins.
 * support is the shared low-level toolbox (errors, util, normalize, audit,
 * lease arithmetic, schema, pure format validators, pure document semantics);
 * it is not one of the six layers.
 */
export const LAYER_PREFIXES = [
  ['lib/shared/', 'shared'],
  ['lib/core/business/', 'business'],
  ['lib/core/application/dto.js', 'dto'],
  ['lib/core/application/', 'application'],
  ['lib/core/commands/', 'command'],
  ['lib/core/domain/', 'model'],
  ['lib/core/model.js', 'model'],
  ['lib/core/transaction/model.js', 'model'],
  ['lib/core/transaction/records.js', 'model'],
  ['lib/core/transaction/work.js', 'adapter'],
  ['lib/core/transaction/', 'model'],
  ['lib/core/runtime/', 'runtime'],
  ['lib/core/store/format.js', 'support'],
  ['lib/core/store.js', 'persistence'],
  ['lib/core/store/', 'persistence'],
  ['lib/core/projection/', 'projection'],
  ['lib/core/views.js', 'projection'],
  ['lib/core/project-reader-projection.js', 'projection'],
  ['lib/core/reader/', 'reader'],
  ['lib/core/project-reader.js', 'reader'],
  ['lib/core/project-reader-views.js', 'reader'],
  ['lib/core/project-reader-worker.js', 'reader'],
  ['lib/core/project-read-handle.js', 'reader'],
  ['lib/core/project-list-reader.js', 'reader'],
  ['lib/core/project-list-worker.js', 'reader'],
  ['lib/core/knowledge/', 'index'],
  ['lib/core/documents/external-model.js', 'support'],
  ['lib/core/documents/', 'documents'],
  ['lib/core/adapters/', 'adapter'],
  ['lib/core/identity/', 'identity'],
  ['lib/core/service.js', 'runtime'],
  ['lib/core/handle.js', 'runtime'],
  ['lib/host/', 'host'],
  ['lib/index.js', 'assembly'],
];

export function layerOf(rel) {
  const normalized = String(rel).replace(/\\/g, '/');
  if (normalized === 'lib/client.js') return 'generated-client';
  for (const [prefix, layer] of LAYER_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) return layer;
  }
  if (normalized.startsWith('lib/core/')) {
    const rest = normalized.slice('lib/core/'.length);
    const first = rest.split('/')[0];
    if (!rest.includes('/')) return 'support';
    if (KNOWN_CORE_DIRS.has(first)) return 'support';
    return null;
  }
  return null;
}

export const KNOWN_CORE_DIRS = new Set([
  'application', 'business', 'commands', 'domain', 'transaction', 'store',
  'projection', 'reader', 'documents', 'adapters', 'identity', 'knowledge',
]);

export const FORBIDDEN_IMPORTS = Object.freeze({
  shared: new Set(['business', 'dto', 'application', 'command', 'model', 'persistence', 'projection', 'reader', 'documents', 'adapter', 'runtime', 'host', 'assembly']),
  business: new Set(['application', 'command', 'model', 'persistence', 'projection', 'reader', 'documents', 'adapter', 'runtime', 'host', 'assembly']),
  dto: new Set(['business', 'application', 'command', 'model', 'persistence', 'projection', 'reader', 'documents', 'adapter', 'runtime', 'host', 'assembly']),
  model: new Set(['business', 'application', 'command', 'persistence', 'projection', 'reader', 'runtime', 'host', 'assembly']),
  persistence: new Set(['business', 'application', 'command', 'projection', 'reader', 'runtime', 'host', 'assembly']),
  projection: new Set(['business', 'application', 'command', 'persistence', 'reader', 'runtime', 'host', 'assembly']),
  reader: new Set(['business', 'application', 'command', 'runtime', 'host', 'assembly']),
  command: new Set(['application', 'persistence', 'runtime', 'host', 'assembly']),
  application: new Set(['runtime', 'host', 'assembly']),
  documents: new Set(['business', 'application', 'command', 'host', 'assembly']),
  adapter: new Set(['business', 'application', 'command', 'host', 'assembly']),
  support: new Set([]),
  index: new Set([]),
  identity: new Set([]),
  runtime: new Set([]),
  host: new Set([]),
  assembly: new Set([]),
});

export const MODEL_LAYERS = new Set(['model']);
/** Replay constructs a fresh value from validated history; it is not a mutation. */
export const REPLAY_BUILDERS = new Set(['lib/core/store/format.js']);
export const NO_GO_LAYERS = new Set(['business', 'model', 'projection']);
export const PURE_LAYERS = new Set(['business', 'model']);
export const READER_LAYERS = new Set(['reader', 'projection', 'business', 'model']);

/** Methods that require a ProjectHandle / ProjectService receiver. */
export const HANDLE_ONLY_METHODS = new Set([
  'open', 'openByWorkspace', 'touch', 'attach', 'detach', '_appendEvents',
]);
/** Methods that are legal on an application facade, and illegal on service/handle. */
export const COMMAND_METHODS = new Set(['command', 'createProject']);
export const HANDLE_HELPERS = new Set(['resolveHandle', 'trackHandle']);
/** Receivers whose command/createProject call is the application ingress port. */
export const SAFE_RECEIVERS = new Set([
  'app', 'application', 'facade', 'source', 'ingress', 'runtime.application',
]);
/** Host files that are the lifecycle assembly, not an ordinary ingress path. */
export const HOST_LIFECYCLE_FILES = new Set(['lib/host/lifecycle.js', 'lib/host/agent-context.js']);
export const HOST_LIFECYCLE_METHODS = new Set(['open', 'openByWorkspace', 'attach', 'detach', 'trackHandle']);

export const PRIVATE_WRITE_CALLS = new Set(['_appendEvents', 'commitPhysical', 'saveSnapshot']);

/**
 * Raw append/publish entry points. These are authorized only in the named
 * model/transaction/replay/maintenance modules below; a directory wildcard is
 * never an authorization.
 */
export const RAW_WRITE_METHODS = new Set([
  'makeCommit', 'commitRecord', 'commitPhysical', 'saveSnapshot', 'applyEvent', 'publish', 'writeEvents',
]);
export const RAW_WRITE_DEFINITIONS = new Set([
  '_appendEvents', 'appendEvents', 'writeEvents', 'setState', 'mutateState',
]);
export const RAW_WRITE_ALLOW = Object.freeze({
  // The transaction model is the sole project publisher. Private #commitRecord
  // and #publish are not additional entries.
  'lib/core/transaction/model.js': new Set(['makeCommit', 'commitPhysical', 'saveSnapshot', 'applyEvent', 'publish']),
  // Verified-history replay / operation application on the private projection.
  'lib/core/transaction/operations.js': new Set(['applyEvent']),
  'lib/core/transaction/records.js': new Set(['applyEvent']),
  'lib/core/store/format.js': new Set(['applyEvent']),
  // Physical persistence only: no append/publish of a new project commit.
  'lib/core/store.js': new Set(['commitPhysical', 'saveSnapshot']),
  // Synthetic fixture only; never a production write path.
  'lib/core/documents/migration-fixture.js': new Set(['makeCommit']),
  // Materialized search-index publish, not a project commit.
  'lib/core/knowledge/build.js': new Set(['publish']),
  'lib/core/model.js': new Set(['applyEvent']),
});
/** Command files may not import the model/transaction implementation directly. */
export const COMMAND_FORBIDDEN_IMPORTS = new Set([
  'lib/core/model.js', 'lib/core/handle.js', 'lib/core/service.js', 'lib/core/store.js',
  'lib/core/transaction/model.js', 'lib/core/transaction/operations.js', 'lib/core/transaction/records.js',
]);
export const COMMAND_FORBIDDEN_RETURN_FIELDS = new Set(['events', 'state', 'handle', 'writer', 'commit']);
export const COMMAND_WRITE_FUNCTION = /^(write|publish|append|commit|mutate|setState)([A-Z_]|$)/;
export const COMMAND_HANDLER_NAME = /^(task|plan|project|doc|session|external|override)([A-Z_]|$)/;
/** Function-valued plan fields are callbacks, not value operations. */
export const COMMAND_PLAN_CALLBACKS = new Set(['admit', 'expand', 'execute', 'submit', 'handler']);
export const COMMAND_PLAN_VALUE_FIELDS = new Set(['request', 'operations', 'workSessionSource']);
/** Host activity/attachment writes that must not precede application.command. */
export const COMMAND_PRE_ACTIVITY = new Set(['ensureAgentProject', 'recordActivity', 'touch']);
export const HOST_ACTIVITY_LIFECYCLE_FILES = new Set(['lib/host/lifecycle.js', 'lib/host/agent-context.js']);
/** Exact public command names from lib/shared/contract.js COMMAND_OPS. */
export const PUBLIC_COMMAND_NAMES = new Set([
  'project.update', 'project.relocate', 'plan.create', 'plan.publish', 'plan.revise', 'plan.adopt', 'plan.release',
  'plan.rename', 'plan.archive', 'plan.unarchive', 'plan.focus', 'task.create', 'task.update', 'task.gate', 'task.ready',
  'task.claim', 'task.begin', 'task.renew', 'task.submit', 'task.verify', 'task.reject', 'task.block', 'task.interrupt',
  'task.unblock', 'task.release', 'task.reconcile', 'task.cancel', 'task.reopen', 'doc.put', 'doc.link',
  'doc.external.register', 'doc.external.update_meta', 'doc.external.relocate', 'doc.external.rebind', 'doc.external.confirm',
  'doc.external.unregister', 'doc.workspace_capture', 'doc.external.migrate', 'doc.inline_policy', 'session.checkpoint', 'session.handoff', 'override',
]);
export const FS_WRITE_CALLS = new Set([
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir',
  'rmSync', 'rm', 'rmdirSync', 'rmdir', 'renameSync', 'rename', 'unlinkSync', 'unlink',
  'copyFileSync', 'copyFile', 'cpSync', 'cp', 'createWriteStream',
]);
export const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);
export const IO_BUILTINS = new Set([
  'fs', 'fs/promises', 'child_process', 'http', 'https', 'net', 'tls', 'dgram',
  'worker_threads', 'cluster', 'repl', 'readline', 'process',
]);
export function isNodeBuiltin(spec) {
  return spec.startsWith('node:') || NODE_BUILTINS.has(spec);
}
export function isIoBuiltin(spec) {
  return IO_BUILTINS.has(spec.replace(/^node:/, ''));
}

/**
 * Maintenance-script inventory. Every top-level scripts/*.mjs must be listed,
 * and every entry must exist. Modes:
 *   read / inventory / dry-run / apply / ops / fixture / tooling
 * isolation documents why a writer on a copy is not a production writer.
 * gate lists literal confirmation/command tokens. gateMode command means the
 * subcommand itself is the gate.
 */
export const SCRIPT_POLICY = Object.freeze({
  'scripts/bench-capacity.mjs': { modes: ['fixture'], isolation: 'explicit --dir temp fixture' },
  'scripts/build-client.mjs': { modes: ['tooling'] },
  'scripts/check-architecture.mjs': { modes: ['read'] },
  'scripts/check-backend-layers.mjs': { modes: ['read'] },
  'scripts/check-client-layers.mjs': { modes: ['read'] },
  'scripts/check-docs.mjs': { modes: ['read'] },
  'scripts/check-docs.test.mjs': { modes: ['tooling'] },
  'scripts/check-release-purity.mjs': { modes: ['read'] },
  'scripts/check-test-docs.mjs': { modes: ['tooling'] },
  'scripts/check-test-size.mjs': { modes: ['read'] },
  'scripts/code-metrics.mjs': { modes: ['tooling'] },
  'scripts/contrast-check.mjs': { modes: ['read'] },
  'scripts/deck.mjs': { modes: ['apply'], gateMode: 'command', gate: ['task.claim', 'task.begin', 'task.submit', 'task.verify'] },
  'scripts/doc-migration.mjs': { modes: ['dry-run', 'apply'], gate: ['--apply'] },
  'scripts/guards.mjs': { modes: ['tooling'] },
  'scripts/identity.mjs': { modes: ['dry-run', 'apply'], gateMode: 'command', gate: ['migrate', 'relocate', 'fork', 'import', 'mark', 'bind', 'unbind'] },
  'scripts/install.mjs': { modes: ['tooling'] },
  'scripts/issue-space-grant.mjs': { modes: ['tooling'], isolation: 'local issuance; emits a bearer and grant, does not write a board or install the grant' },
  'scripts/maintainability-audit.mjs': { modes: ['read'] },
  'scripts/measure-context-cost.mjs': { modes: ['tooling'] },
  'scripts/migrate-gate-v3.mjs': { modes: ['dry-run', 'ops'], gate: ['--apply', '--dry-run'] },
  'scripts/migrate-plans.mjs': { modes: ['inventory'], isolation: 'temp-copy' },
  'scripts/mutation-check.mjs': { modes: ['tooling'] },
  'scripts/recovery-drill.mjs': { modes: ['fixture'], isolation: 'synthetic only, refuses arguments' },
  'scripts/release-readiness.mjs': { modes: ['tooling'] },
  'scripts/release-tag.mjs': { modes: ['tooling'] },
  'scripts/relocate-project.mjs': { modes: ['dry-run', 'apply'], gate: ['--dry-run'] },
  'scripts/repair-log.mjs': { modes: ['dry-run', 'ops'], gate: ['--apply', '--confirm-data-loss'] },
  'scripts/restore-acceptance.mjs': { modes: ['dry-run', 'ops'], gate: ['--apply'] },
  'scripts/run-suite.mjs': { modes: ['tooling'] },
  'scripts/salvage-log.mjs': { modes: ['inventory'] },
  'scripts/stores-replay.mjs': { modes: ['inventory', 'apply'], isolation: 'temp-copy', gate: ['--update'] },
  'scripts/test-env-open.mjs': { modes: ['tooling'] },
  'scripts/test-env-seed.mjs': { modes: ['fixture'], isolation: 'isolated test-env home only' },
  'scripts/test-env-verify.mjs': { modes: ['read'] },
  'scripts/test-env.mjs': { modes: ['tooling'] },
  'scripts/typecheck-client.mjs': { modes: ['tooling'] },
  'scripts/typecheck-test.mjs': { modes: ['tooling'] },
  'scripts/typecheck.mjs': { modes: ['tooling'] },
});

/** Support modules under the new scripts/backend-layers/ directory. */
export const SCRIPT_MODULES = Object.freeze({
  'scripts/backend-layers/ast.mjs': { modes: ['tooling'] },
  'scripts/backend-layers/capabilities.mjs': { modes: ['tooling'] },
  'scripts/backend-layers/config.mjs': { modes: ['tooling'] },
  'scripts/backend-layers/lib-rules.mjs': { modes: ['tooling'] },
  'scripts/backend-layers/report.mjs': { modes: ['tooling'] },
  'scripts/backend-layers/script-rules.mjs': { modes: ['tooling'] },
});
