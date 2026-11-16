import vm from 'node:vm';

const row = (name, schema, value) => ({ name, schema, value });
const record = { type: 'object', properties: { v: { type: 'integer' } }, required: ['v'], additionalProperties: false };

// Factories preserve values JSON.stringify would erase (holes, -0, undefined).
export function sdkValidationCases() {
  const cycle = {}; cycle.self = cycle;
  const shared = { ok: 1 };
  const nonEnumerableIndex = [];
  Object.defineProperty(nonEnumerableIndex, '0', { value: 1 });
  const extraArray = [1]; extraArray.extra = 1;
  const symbolObject = { v: 1, [Symbol('hidden')]: 2 };
  const hidden = Object.defineProperty({ v: 1 }, 'hidden', { value: 2 });
  const spoof = Object.create(Object.assign(Object.create(null), { constructor: Object }));
  const getter = Object.defineProperty({}, 'v', { get: () => 1, enumerable: true });
  const throws = Object.defineProperty({}, 'v', { get() { throw new Error('fixture getter'); }, enumerable: true });
  let deep = null; for (let index = 0; index < 2000; index += 1) deep = { child: deep };
  return [
    row('integer', { type: 'integer' }, 1), row('large integer', { type: 'integer' }, 2 ** 53),
    row('fraction', { type: 'integer' }, 1.5), row('negative zero', { type: 'number' }, -0),
    row('NaN', { type: 'number' }, NaN), row('infinity', { type: 'number' }, Infinity),
    row('string', { type: 'string' }, '汉🙂'), row('boolean', { type: 'boolean' }, false),
    row('null', { type: 'null' }, null), row('undefined JSON', {}, undefined),
    row('missing required', record, {}), row('undefined required', record, { v: undefined }),
    row('valid record', record, { v: 2 }), row('unknown field', record, { v: 2, other: true }),
    row('open extra undefined', { type: 'object' }, { extra: undefined }),
    row('null prototype', record, Object.assign(Object.create(null), { v: 1 })),
    row('other realm object', record, vm.runInNewContext('({v: 1})')),
    row('Date', { type: 'object' }, new Date(0)), row('Map', { type: 'object' }, new Map()),
    row('spoofed Object prototype', { type: 'object' }, spoof),
    row('enumerable symbol', { type: 'object' }, symbolObject),
    row('non enumerable object key', { type: 'object' }, hidden),
    row('getter', record, getter), row('throwing getter', record, throws),
    row('array', { type: 'array', items: { type: 'integer' } }, [1, 2]),
    row('other realm array', { type: 'array' }, vm.runInNewContext('[1,2]')),
    row('array non enumerable index', { type: 'array' }, nonEnumerableIndex),
    row('array extra key', { type: 'array' }, extraArray),
    row('sparse array', { type: 'array' }, Array(2)),
    row('array subclass', { type: 'array' }, new (class extends Array {})(1)),
    row('cycle', { type: 'object' }, cycle), row('shared DAG', { type: 'object' }, { a: shared, b: shared }),
    row('deep JSON', {}, deep),
    row('enum accepted', { type: 'string', enum: ['a', 'b'] }, 'a'),
    row('enum rejected', { type: 'string', enum: ['a', 'b'] }, 'x'),
    row('const rejected', { type: 'integer', const: 3 }, 4),
    row('oneOf accepted', { oneOf: [{ type: 'string' }, { type: 'integer' }] }, 1),
    row('oneOf ambiguous', { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1),
    row('oneOf none', { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 'x'),
  ];
}
