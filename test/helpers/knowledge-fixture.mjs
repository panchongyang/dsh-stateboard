import fs from 'node:fs';
import path from 'node:path';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { withProject, command } from './service-fixture.mjs';

export const human = { kind: 'human', via: 'test' };
export const cmd = (op, fields = {}) => command(op, { actor: human, ...fields });

export async function knowledgeFixture(t, options = {}) {
  const fixture = await withProject(t, { privilegedInlineWrites: true });
  const reader = createKnowledgeReader(fixture.svc, options);
  t.after(() => reader.close());
  const projectId = fixture.h.id;
  return { ...fixture, reader, projectId,
    search: (query, args = {}) => reader.search({ projectId, query, relatedLimit: 0, ...args }),
    read: (refs, args = {}) => reader.read({ projectId, refs: Array.isArray(refs) ? refs : [refs], ...args }),
  };
}

export async function addTask(h, title, extra = {}) {
  const result = await h.command(cmd('task.create', { title, acceptance: [{ text: 'Verify fixture result' }], ...extra }));
  return result.events[0].data.id;
}

export function tree(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [path.relative(root, file), fs.readFileSync(file, 'base64')]);
}

export async function registerFile(fixture, name, text, extra = {}) {
  const file = path.join(fixture.wsDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const result = await fixture.h.command(cmd('doc.external.register', { title: name, relPath: name, ...extra }));
  return { file, docId: result.docId };
}
