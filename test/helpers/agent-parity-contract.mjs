import assert from 'node:assert/strict';

export function assertCatalogue(native, remote) {
  assert.deepEqual(remote.map(({ name }) => name), [...native.keys()]);
  for (const entry of remote) {
    assert.equal(entry.description, native.get(entry.name).description);
    assert.deepEqual(entry.inputSchema, native.get(entry.name).parameters);
  }
}
