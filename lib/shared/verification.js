// A persisted ordinary pass is a self-declared acceptance; only a gated pass
// is an independent agent audit. Legacy records with no gate keep their label.
export function isOrdinaryAgentAcceptance(record) {
  return record?.by?.kind === 'agent' && record.verdict === 'pass' && record.gate === false;
}
