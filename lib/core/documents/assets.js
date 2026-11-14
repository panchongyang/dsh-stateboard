import path from 'node:path';
import { BoardError } from '../errors.js';
import { readFailure, readLocator, reloadBindings } from './external-observe.js';

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
]);

export function readImageAsset(handle, docId, rawPath) {
  const doc = handle.state.docs[docId];
  if (!doc || doc.source !== 'external') throw new BoardError('not-found', 'external document not found', { status: 404 });
  // 请求路径先做词法校验；允许父目录段，但不接受本机路径、空段或控制字符。
  if (typeof rawPath !== 'string' || !rawPath || /[\\:\x00-\x1f\x7f-\x9f]/.test(rawPath)
    || path.posix.isAbsolute(rawPath) || rawPath.split('/').some((part) => part === '')) {
    throw new BoardError('security-rejected', 'invalid relative image path', { status: 403 });
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc.locator.relPath), rawPath));
  if (resolved === '..' || resolved.startsWith('../')) throw new BoardError('outside-root', 'image is outside the binding root', { status: 403 });
  const contentType = TYPES.get(path.posix.extname(resolved).toLowerCase());
  if (!contentType) throw new BoardError('unsupported-format', 'image format is not supported', { status: 415 });
  // 物理路径、链接与读取上限复用文档安全域；错误仅返回分类，不泄露本机绝对路径。
  reloadBindings(handle);
  const { read } = readLocator(handle, { bindingId: doc.locator.bindingId, relPath: resolved }, { includeBytes: true, maxBytes: IMAGE_MAX_BYTES });
  if (!read.ok) throw readFailure(read);
  if (!read.bytes) throw new BoardError('unsupported-format', 'image bytes are unavailable', { status: 415 });
  return { bytes: read.bytes, contentType, size: read.size, hash: read.hash };
}
