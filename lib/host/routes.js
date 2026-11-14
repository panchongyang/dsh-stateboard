import { authorizeWebRequest } from './auth.js';
import { requireId, routePath, sendJson, sendError } from './util.js';
import { notFound, parseParts, summaryOf } from './routes/shared.js';
import { projectsRoute } from './routes/projects.js';
import { boardRoute } from './routes/board.js';
import { taskRoute } from './routes/tasks.js';
import { plansRoute, currentPlanRoute, planRoute } from './routes/plans.js';
import { peekReadOnlyState } from '../core/documents/assets.js';
import { docsRoute, docRoute, externalDocsRoute, externalDocRoute, externalDocAssetRoute, externalDocActionRoute, prepareExternalWrite } from './routes/docs.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { commandsRoute } from './routes/commands.js';

// Resource dispatch table. A route matches on shape and method only; the
// handler owns the query/command call. Order is irrelevant because the
// matchers are disjoint.
const RESOURCES = [
  [(parts, method) => parts.length === 3 && parts[2] === 'board' && method === 'GET', boardRoute],
  [(parts, method) => parts.length === 4 && parts[2] === 'tasks' && method === 'GET', taskRoute],
  [(parts, method) => parts.length === 3 && parts[2] === 'plans' && method === 'GET', plansRoute],
  [(parts, method) => parts.length === 4 && parts[2] === 'plans' && parts[3] === 'current' && method === 'GET', currentPlanRoute],
  [(parts, method) => parts.length === 4 && parts[2] === 'plans' && method === 'GET', planRoute],
  [(parts, method) => parts.length === 3 && parts[2] === 'docs' && method === 'GET', docsRoute],
  // The external surface owns the `docs/external` subtree; the inline doc matcher
  // below explicitly excludes it so `external` is never parsed as a docId.
  [(parts, method) => parts.length === 4 && parts[2] === 'docs' && parts[3] === 'external' && (method === 'GET' || method === 'POST'), externalDocsRoute],
  [(parts, method) => parts.length === 5 && parts[2] === 'docs' && parts[3] === 'external' && (method === 'GET' || method === 'PATCH'), externalDocRoute],
  [(parts, method) => parts.length === 6 && parts[2] === 'docs' && parts[3] === 'external' && method === 'POST', externalDocActionRoute],
  [(parts, method) => parts.length === 4 && parts[2] === 'docs' && parts[3] !== 'external' && method === 'GET', docRoute],
  [(parts, method) => parts.length === 3 && parts[2] === 'events' && method === 'GET', eventsRoute],
  [(parts, method) => parts.length === 3 && parts[2] === 'health' && method === 'GET', healthRoute],
];

async function handleApi(req, res, runtime) {
  const { denial, authority } = authorizeWebRequest(req, runtime.token);
  if (denial) return sendJson(res, 403, { ok: false, error: { code: denial, message: denial === 'token-mismatch' ? 'Page capability does not match this plugin instance.' : 'Request source rejected.' } });
  const { path: route, url } = routePath(req);
  const parts = parseParts(route);
  const method = req.method || 'GET';

  if (method === 'GET' && parts.length === 1 && parts[0] === 'ping') {
    return sendJson(res, 200, { ok: true, name: 'project-board', rev: 1 });
  }

  await runtime.ready;

  if (parts.length === 1 && parts[0] === 'projects') return projectsRoute(req, res, runtime, method, authority);
  if (parts.length < 2 || parts[0] !== 'projects') return notFound(res);

  const projectId = requireId(parts[1], 'prj', 'projectId');
  if (parts.length === 3 && parts[2] === 'commands' && method === 'POST') {
    return commandsRoute(req, res, projectId, runtime.service, authority);
  }
  // Asset reads are lock-free: a cold document image must not open a writer or run recovery.
  if (parts.length === 6 && parts[2] === 'docs' && parts[3] === 'external' && parts[5] === 'assets' && method === 'GET') {
    return externalDocAssetRoute(req, res, url, parts, peekReadOnlyState(runtime.service, projectId));
  }
  // External writes are validated from the request body before the project is
  // opened: a cold open runs recovery, so a later 400 would already have
  // written to the log. Rejecting here keeps "400 means zero writes" true.
  const prepared = await prepareExternalWrite(req, parts, method);
  const handle = await runtime.service.open(projectId);
  if (parts.length === 2 && method === 'GET') return sendJson(res, 200, { ok: true, project: summaryOf(handle) });

  for (const [match, handler] of RESOURCES) {
    if (match(parts, method)) return handler(req, res, url, parts, handle, { prepared, authority });
  }
  return notFound(res, route);
}

/**
 * Register /project-board/api and inject the process token into the served index.
 * The web server is optional: in a headless composition the tools still work.
 */
export function registerRoutes(ctx, runtime) {
  const web = ctx.webServer || ctx.get('webServer');
  if (!web) return null;
  const disposer = web.register({
    kind: 'prefix',
    path: '/project-board/api',
    handler: (req, res) => {
      Promise.resolve(handleApi(req, res, runtime)).catch((error) => sendError(res, error, ctx.logger));
    },
  });
  const offInject = ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__PROJECT_BOARD__',
      value: { token: runtime.token, base: '/project-board/api' },
    });
  });
  return () => {
    try { disposer(); } catch { /* already disposed */ }
    try { offInject(); } catch { /* already disposed */ }
  };
}
