import { BoardError } from '../../core/errors.js';
import { createKnowledgeReader } from '../../core/knowledge/reader.js';
import { KNOWLEDGE_DESCRIPTIONS, KNOWLEDGE_INPUTS, KNOWLEDGE_TOOLS } from '../../shared/knowledge.js';
import { run, textBlock } from './shared.js';
import { projectionAuthority } from '../agent-context.js';
import { renderKnowledgeText } from './knowledge-text.js';

// Material is transport-local; never attach it as an enumerable tool result.
const modelMaterial = new WeakMap();
export function carryKnowledgeModelMaterial(value, normalized) {
  if (modelMaterial.has(value)) modelMaterial.set(normalized, modelMaterial.get(value));
}


const LIMIT_LABELS = {
  minimum: 'Minimum', maximum: 'Maximum', minLength: 'Minimum length', maxLength: 'Maximum length',
  minItems: 'Minimum items', maxItems: 'Maximum items',
};

// DSH PTC 只接受结构子集；保留字段/必填/枚举，把范围转成说明，core 仍强制相同边界。
function nativeInput(schema) {
  const result = {};
  const limits = [];
  for (const [key, value] of Object.entries(schema)) {
    if (Object.hasOwn(LIMIT_LABELS, key)) limits.push(LIMIT_LABELS[key] + ': ' + value + '.');
    else if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, nativeInput(property)]));
    else if (key === 'items') result.items = nativeInput(value);
    else result[key] = value;
  }
  if (limits.length) result.description = [schema.description, ...limits].filter(Boolean).join(' ');
  return result;
}

// 原生身份只来自宿主会话；读写都不得借用写路径的 writer/touch 副作用。
async function projectFor(runtime, exec) {
  if (!exec?.agent?.id) throw new BoardError('forbidden-role', 'Knowledge tools require an owning agent session', { status: 403 });
  const cwd = exec.agent.session?.header?.cwd;
  if (typeof cwd !== 'string' || !cwd) throw new BoardError('invalid-command', 'The session has no working directory', { status: 400 });
  await runtime.ready;
  const found = runtime.service.resolveWorkspace(cwd);
  if (!found) throw new BoardError('not-found', 'No ProjectBoard project is bound to this workspace', { status: 404 });
  return found.projectId;
}

// DSH register 接收 JSON Schema ToolDefinition；业务 schema 与 MCP 共用，校验由 core 收口。
export function register(ctx, runtime) {
  const reader = createKnowledgeReader(runtime.service);
  ctx.effect(() => () => reader.close(), 'project-board.knowledge.close()');
  for (const operation of ['search', 'read']) {
    ctx.tools.register({
      name: KNOWLEDGE_TOOLS[operation],
      description: KNOWLEDGE_DESCRIPTIONS[operation],
      parameters: nativeInput(KNOWLEDGE_INPUTS[operation]),
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => textBlock(renderKnowledgeText(operation, args, value, modelMaterial.get(value))) },
      execute: (args, exec) => run(async () => {
        exec?.signal?.throwIfAborted();
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, 'projectId')) {
          throw new BoardError('invalid-command', 'Knowledge arguments must not specify a project', { status: 400 });
        }
        const projectId = await projectFor(runtime, exec);
        // Scoped native and MCP calls already share this registrar. Only the
        // trusted execution can supply projection authority; legacy test mode
        // has no owning space and must not acquire workspace visibility.
        const authority = runtime.service.spaceHome || runtime.service.assertAccess
          ? projectionAuthority(exec, { ctx: runtime.ctx, service: runtime.service }) : undefined;
        let material;
        const value = await reader[operation]({ ...args, projectId }, {
          signal: exec.signal, authority, onModelMaterial: rows => { material = rows; },
        });
        if (material?.length) modelMaterial.set(value, material);
        return value;
      }),
    });
  }
}
