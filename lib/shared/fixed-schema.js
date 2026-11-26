export const FIXED_REFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Deprecated Git provenance selector for recorded sources only; original bytes are not read.',
  properties: {
    v: { type: 'integer', required: true },
    projectId: { type: 'string', required: true },
    commitOid: { type: 'string', required: true },
    pathAtCommit: { type: 'string', required: true },
    blobOid: { type: 'string', required: true },
    objectFormat: { type: 'string', required: true, enum: ['sha1', 'sha256'] },
    blobContentHash: { type: 'string', required: true },
  },
};
