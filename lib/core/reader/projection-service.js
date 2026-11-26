// Trusted owning-space port. Scan requests carry business arguments only; neither
// a pathname nor a cursor selects a store, credential, scanner budget or policy.
import { BoardError } from '../errors.js';
import { PROJECTION_DOC_FIELDS, PROJECTION_MAX_BYTES, PROJECTION_CURSOR_MAX_LENGTH, PROJECTION_RELPATH_MAX_LENGTH } from '../../shared/agent-tools.js';
import { validateRelPath } from '../domain/document-path.js';
import { capabilities, contextOf, detachProjectionOwner, assertAuthority } from './projection-context.js';
import { workspaceHints } from './projection-hints.js';
import { workspaceProjectionPool } from './projection-pool.js';

const invalid = () => new BoardError('invalid-command','Invalid workspace projection request',{status:400});
function requestOf(input) {
  if (!input || !Object.hasOwn(PROJECTION_DOC_FIELDS,input.op) || Object.keys(input).some(k => k !== 'op' && !PROJECTION_DOC_FIELDS[input.op].includes(k))) throw invalid();
  const request = {op:input.op};
  if (input.op !== 'discover') {
    if (typeof input.relPath !== 'string' || input.relPath.length > PROJECTION_RELPATH_MAX_LENGTH || !validateRelPath(input.relPath).ok) throw invalid();
    request.relPath = input.relPath;
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !input.cursor.length || input.cursor.length > PROJECTION_CURSOR_MAX_LENGTH) throw invalid();
    request.cursor = input.cursor;
  }
  if (input.maxBytes !== undefined) {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > PROJECTION_MAX_BYTES) throw invalid();
    request.maxBytes = input.maxBytes;
  }
  return request;
}
async function recheck(service,projectId,authority,expected) {
  await assertAuthority(service,authority);
  if (contextOf(service,projectId,authority).scopeKey !== expected.scopeKey) throw new BoardError('restart-required','Workspace discovery context changed; start again');
}
async function submit(service,projectId,request,authority,context,background) {
  const check = () => recheck(service,projectId,authority,context);
  const startedAt = new Date().toISOString();
  let result;
  try { result = await workspaceProjectionPool.submit(context,request,{background,check}); }
  catch (e) {
    // Suppress even an observation error if this caller has since lost access.
    await check();
    if (request.op !== 'discover' || e.code !== 'projection-timeout') throw e;
    result = {workspaceContext:context.workspaceContext,policyVersion:context.policyVersion,scanGeneration:null,startedAt,observedAt:null,
      entries:[],counts:{enumerated:0,read:0,reused:0,indexed:0},errors:{'scan-timeout':1},excluded:{},rejected:{},partial:true,nextCursor:null,restartRequired:true};
  }
  await check();
  return {...result,watcher:workspaceHints.status(context.scopeKey),git:'not-required'};
}
export async function queryWorkspaceProjection(service,projectId,input,provided) {
  service._assertOpen();
  const authority = capabilities(service,provided);
  await assertAuthority(service,authority);
  const context = contextOf(service,projectId,authority);
  const request = requestOf(input);
  // A successful live-authority read renews activity even without session open.
  const result = await submit(service,projectId,request,authority,context,false);
  if (provided) maintainHint(service,projectId,authority,context,true);
  return result;
}
function maintainHint(service,projectId,authority,context,alreadyScanning) {
  workspaceHints.hint({owner:context.owner,key:context.scopeKey,root:context.root,
    check:() => recheck(service,projectId,authority,context),
    scan:cursor => submit(service,projectId,cursor ? {op:'discover',cursor} : {op:'discover'},authority,context,true)}, {alreadyScanning});
}
export function hintWorkspaceProjection(service,projectId,provided) {
  // Memory-only admission: the worker verifies the captured medium before and
  // after scanning. A hint neither reads disk nor starts scanning synchronously.
  const authority = capabilities(service,provided);
  maintainHint(service,projectId,authority,contextOf(service,projectId,authority),false);
}
export async function closeWorkspaceProjection(service) {
  const id = detachProjectionOwner(service);
  if (id) { workspaceHints.close(id); await workspaceProjectionPool.release(id); }
}
