import { BoardError } from '../../core/errors.js';
import { fail } from './shared.js';
import { losslessJson } from './json-value.js';

// Compile the small authoring form to a registry-ready DSH ToolDefinition.
// This layer has no host peer dependency, so real registration/execution parity
// runs in offline CI. The SDK compatibility test checks the same definitions.
function schemaNode(spec) {
  const { required: _required, ...node } = spec;
  if (node.type === 'json') delete node.type;
  if (node.properties) {
    const entries = Object.entries(node.properties);
    node.properties = Object.fromEntries(entries.map(([key, value]) => [key, schemaNode(value)]));
    const required = entries.filter(([, value]) => value.required === true).map(([key]) => key);
    if (required.length) node.required = required;
  }
  if (node.items) node.items = schemaNode(node.items);
  if (node.oneOf) node.oneOf = node.oneOf.map(schemaNode);
  return node;
}

export function validateInput(schema, value, at = 'arguments') {
  const invalid = (message) => {
    const violation = at + ' ' + message;
    const error = fail(new BoardError('INVALID_ARGS', 'invalid arguments: ' + violation, { status: 400 }));
    error.name = 'ToolArgsError';
    error.violations = [violation];
    throw error;
  };
  if (at === 'arguments' && !losslessJson(value)) invalid('must be lossless JSON');
  if (schema.oneOf) {
    let matches = 0;
    for (const choice of schema.oneOf) {
      try { validateInput(choice, value, at); matches += 1; } catch { /* try next variant */ }
    }
    if (matches !== 1) invalid('must match exactly one variant');
  }
  if (schema.enum && !schema.enum.includes(value)) invalid('has an unsupported value');
  if (Object.hasOwn(schema, 'const') && schema.const !== value) invalid('has an unsupported value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('must be an object');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid('requires ' + key);
    for (const [key, entry] of Object.entries(value)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : null;
      if (property) validateInput(property, entry, at + '.' + key);
      else if (schema.additionalProperties === false) invalid('has unknown field ' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid('must be an array');
    if (schema.items) value.forEach((item, index) => validateInput(schema.items, item, at + '[' + index + ']'));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) invalid('must be an integer');
  } else if (schema.type === 'number') {
    if (!Number.isFinite(value)) invalid('must be a finite number');
  } else if (schema.type === 'null') {
    if (value !== null) invalid('must be null');
  } else if (schema.type && typeof value !== schema.type) invalid('must be ' + schema.type);
}

export function defineTool(options) {
  const parameters = schemaNode({ type: 'object', properties: options.parameters });
  return {
    ...options, parameters,
    output: { ...options.output, schema: schemaNode(options.output.schema) },
    async execute(args, exec) {
      validateInput(parameters, args);
      return options.execute(args, exec);
    },
  };
}

export function validateOutput(schema, value) {
  try {
    validateInput(schema, value);
  } catch {
    const error = new Error('Tool returned a value outside its declared JSON output schema');
    error.name = 'ToolOutputError';
    error.code = 'INVALID_OUTPUT';
    throw error;
  }
}
