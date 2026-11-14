import { createServer } from 'node:http';
import { createProjectReader } from '../core/project-reader.js';
import { createMcpHandler } from './mcp-http.js';
import { projectReadTools } from './mcp-tools.js';
import { createMcpWrite } from './mcp-write.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 33109;
const TOKEN_ENV = 'PROJECT_BOARD_MCP_TOKEN';

/** Start the optional MCP listener and return its async disposer. */
export function mountProjectMcp(runtime, settings, env = process.env) {
  if (Object.getOwnPropertyDescriptor(settings ?? {}, 'enabled')?.value !== true) return null;

  const logger = runtime.ctx.logger;
  const port = settings.port === undefined ? DEFAULT_PORT : settings.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger?.warn?.('[project-board] MCP disabled: mcp.port must be an integer from 1 to 65535');
    return null;
  }
  const token = env[TOKEN_ENV];
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    logger?.warn?.('[project-board] MCP disabled: ' + TOKEN_ENV + ' must contain 32 random bytes as lowercase hex');
    return null;
  }

  const reader = createProjectReader(runtime.service);
  const write = createMcpWrite(runtime, Object.getOwnPropertyDescriptor(settings, 'write')?.value, env, token, reader);
  const handler = createMcpHandler({ token, tools: projectReadTools(reader), write, logger });
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 8192 }, handler);
  server.maxConnections = 32;
  let stopping;

  const dispose = () => {
    if (stopping) return stopping;
    const listenerClosed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    stopping = Promise.all([listenerClosed, Promise.resolve().then(() => reader.close()), write?.close()]).then(() => undefined);
    return stopping;
  };

  const stopAfterFailure = (error) => {
    if (stopping) return;
    const detail = error?.code === 'EADDRINUSE' ? 'local port already in use' : 'listener unavailable';
    logger?.warn?.('[project-board] MCP disabled: ' + detail);
    dispose().catch(() => logger?.warn?.('[project-board] MCP cleanup failed'));
  };
  server.on('error', stopAfterFailure);
  server.on('listening', () => logger?.info?.('[project-board] MCP ready at http://' + HOST + ':' + port + '/mcp'));
  runtime.ready.then(() => {
    if (!stopping) server.listen({ host: HOST, port, exclusive: true });
  }).catch(stopAfterFailure);
  return dispose;
}
