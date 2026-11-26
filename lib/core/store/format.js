// Compatibility exports: physical envelope and model-owned replay remain separate.
export { SUPPORTED_COMMIT_VERSION, validateCommit, validateCommits, commitHash, makeCommit, eventActor } from './envelope.js';
export { replayRecords as replay } from '../transaction/records.js';
