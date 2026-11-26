// One serialized worker owns live traversal cursors and derived metadata. It
// checks owning metadata but never opens a writer or appends facts. A lost worker means restart, not recovery.
import { openSpaceDirectory } from '../store/space-home.js';
import { parentPort } from 'node:worker_threads';
import { BoardError } from '../errors.js';
import { createProjectionScanner } from './discovery/scanner.js';

const scanners = new Map();
function assertRoot({root, directoryKey, mediumKey, projectId}) {
  const home = openSpaceDirectory(root);
  if (home.root !== root || home.directoryKey !== directoryKey || home.readMeta()?.projectId !== projectId || home.mediumKey() !== mediumKey) throw new BoardError('space-home-unavailable','The owning root has changed');
}
function discard(key) {
  const item = scanners.get(key);
  scanners.delete(key);
  item?.scanner.close();
}
parentPort.on('message', async ({id, context, request, forget}) => {
  try {
    if (forget) {
      for (const [key,item] of scanners) if (item.owner === forget) discard(key);
      parentPort.postMessage({released:id,empty:scanners.size === 0});
      return;
    }
    assertRoot(context);
    const key = context.scopeKey;
    let item = scanners.get(key);
    if (!item) {
      if (request.cursor) throw new BoardError('restart-required','Scan context expired; start discovery again');
      if (scanners.size >= 8) discard(scanners.keys().next().value);
      item = {owner:context.owner,scanner:createProjectionScanner(context)};
    }
    scanners.delete(key); scanners.set(key,item);
    const result = await item.scanner.execute(request);
    assertRoot(context);
    parentPort.postMessage({id,result});
  } catch (e) {
    if (forget) return;
    const error = e instanceof BoardError ? {code:e.code,message:e.message,status:e.status} : {code:'projection-unavailable',message:'Document observation could not be completed',status:503};
    parentPort.postMessage({id,error});
  }
});
