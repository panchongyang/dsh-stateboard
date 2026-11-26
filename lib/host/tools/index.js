// Host tools, one module per domain. Registration order is the order the model
// sees; it is frozen by test/fixtures/tool-schema.json.
import { register as registerBoard } from './board.js';
import { register as registerDoc } from './doc.js';
import { register as registerPlan } from './plan.js';
import { register as registerSession } from './session.js';
import { register as registerTask } from './task.js';
import { carryKnowledgeModelMaterial, register as registerKnowledge } from './knowledge.js';
import { agentContexts } from '../agent-context.js';
import { AGENT_CONTEXT_PARAMETER } from '../../shared/agent-tools.js';
import { validateInput, validateOutput } from './definition.js';
import { run } from './shared.js';

const REGISTRARS = [registerBoard, registerPlan, registerTask, registerDoc, registerSession, registerKnowledge];

export function agentTools(runtime) {
  if (runtime.agentTools) return runtime.agentTools;
  runtime.sessionProjects ??= new Map();
  runtime.promptFibers ??= new Map();
  const contexts = runtime.spaces ? null : agentContexts(runtime);
  const definitions = [];
  const disposers = [];
  const ctx = {
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
    tools: { register(tool) {
      const parameters = { ...tool.parameters, properties: { ...tool.parameters.properties, context: AGENT_CONTEXT_PARAMETER } };
      const business = ({ context: _context, ...args }) => args;
      const slot = definitions.length;
      const renderers = runtime.spaces ? new WeakMap() : null;
      definitions.push({
        ...tool, parameters,
        output: { ...tool.output, render: (args, value) => {
          const render = renderers?.get(value);
          return render ? render(args, value) : tool.output.render(business(args), value);
        } },
        execute: (args, exec) => run(async () => {
          validateInput(parameters, args);
          exec?.signal?.throwIfAborted();
          if (runtime.spaces) return runtime.spaces.use(exec, async local => {
            const scoped = agentTools(local)[slot];
            const value = await scoped.execute(args, exec);
            if (value && typeof value === 'object') renderers.set(value, scoped.output.render);
            return value;
          });
          const prepared = await contexts.prepare(tool.name, args, exec);
          const value = await tool.execute(business(args), prepared);
          // Native results cross the same JSON boundary as MCP: normalize once so
          // an `undefined` field cannot make the two transports disagree.
          const clean = value === undefined ? value : JSON.parse(JSON.stringify(value));
          validateOutput(tool.output.schema, clean);
          carryKnowledgeModelMaterial(value, clean);
          return clean;
        }),
      });
    } },
  };
  for (const register of REGISTRARS) register(ctx, runtime);
  runtime.closeAgentTools = async () => { await Promise.all(disposers.map((dispose) => dispose())); await contexts?.close(); };
  runtime.agentTools = definitions;
  return definitions;
}

export function registerTools(ctx, runtime) {
  for (const tool of agentTools(runtime)) ctx.tools.register(tool);
  ctx.effect(() => () => runtime.closeAgentTools(), 'project-board.agent-tools.close()');
}
