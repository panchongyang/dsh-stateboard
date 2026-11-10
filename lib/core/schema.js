// Schema upgrades are an explicit maintainer operation outside the runtime package.
import { BoardError } from './errors.js';

export function assertCurrentSchema(state) {
  const incomplete = Object.values(state.tasks || {}).some((task) => typeof task.requiresAudit !== 'boolean');
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 3 || incomplete) {
    throw new BoardError('schema-migration-required', 'This project was created by an unpublished version and needs a maintainer data upgrade. Stop the host and use the release migration tool; do not delete or recreate the project.', {
      status: 409,
      details: { found: state.schemaVersion ?? null, required: 3, reason: incomplete ? 'task-schema-incomplete' : 'store-schema', next: 'Ask the maintainer to run scripts/migrate-gate-v3.mjs --store <project-store> (dry-run), then --apply after backup.' },
    });
  }
  return state;
}
