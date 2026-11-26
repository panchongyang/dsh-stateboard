// Process-local read authority and cache generations. Never reconstructed from a
// caller's cursor, a repository marker, a metadata revision, or a filename.
import { createHash, randomUUID } from 'node:crypto';
import { BoardError } from '../errors.js';
import { validateRelPath } from '../domain/document-path.js';
import { PROJECTION_RELPATH_MAX_LENGTH } from '../../shared/agent-tools.js';

const forbidden = () => new BoardError('project-forbidden','An authorized owning workspace is required',{status:403});
const fingerprint = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const owners = new WeakMap();
export function detachProjectionOwner(service) {
  const id = owners.get(service)?.id; owners.delete(service); return id;
}
function owner(service) {
  if (!owners.has(service)) owners.set(service,{id:randomUUID(),revision:0,rules:null,scopes:new Map()});
  return owners.get(service);
}
export function capabilities(service, authority) {
  if (!authority && !service.assertAccess) return {scopeKey:'local-owner',assertCurrent:() => {}};
  if (typeof authority?.scopeKey !== 'string' || !authority.scopeKey || authority.scopeKey.length > 1024 || typeof authority.assertCurrent !== 'function') throw forbidden();
  return authority;
}
export async function assertAuthority(service, authority) {
  try { await authority.assertCurrent(); }
  catch (error) {
    // A later re-grant may not revive stale cursors from the observed revocation.
    owners.get(service)?.scopes.delete(authority.scopeKey);
    throw error;
  }
}
export function contextOf(service, projectId, authority) {
  // Called in a process-wide queue: the async context creating its worker may
  // have belonged to a different credential. Use the explicit checked grant.
  const home = service.spaceHome;
  const mediumKey = home?.mediumKey();
  if (service._closed || !mediumKey || !service.metas.has(projectId)) throw forbidden();
  const cacheOwner = owner(service);
  // The trusted policy can only narrow discovery. Nothing in the workspace/request can widen it.
  const rules = service.projectionDenyPrefixes?.(projectId) ?? [];
  if (!Array.isArray(rules) || rules.length > 256 || rules.some(r => typeof r !== 'string' || r.length > PROJECTION_RELPATH_MAX_LENGTH || !validateRelPath(r).ok)) throw forbidden();
  const ruleHash = fingerprint(rules);
  if (cacheOwner.rules !== ruleHash) {cacheOwner.rules = ruleHash; cacheOwner.revision++;}
  const credentials = cacheOwner.scopes;
  const epoch = credentials.get(authority.scopeKey) ?? randomUUID();
  credentials.delete(authority.scopeKey); credentials.set(authority.scopeKey,epoch);
  if (credentials.size > 16) credentials.delete(credentials.keys().next().value);
  const workspaceContext = fingerprint([projectId,home.root,mediumKey]);
  const scopeKey = fingerprint([cacheOwner.id,workspaceContext,epoch,cacheOwner.revision]);
  return {owner:cacheOwner.id,root:home.root,directoryKey:home.directoryKey,mediumKey,projectId,workspaceContext,scopeKey,policyVersion:cacheOwner.revision,denyPrefixes:rules.slice()};
}
