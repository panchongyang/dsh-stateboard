import path from 'node:path';
import { BoardError } from '../errors.js';
import { readFailure, readLocator, reloadBindings } from './external-observe.js';

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 锁外回放的只读视图：不调用 open、不获取 writer、不修尾、不恢复在途工作。
 * 只给纯读端点使用；返回值只保证 state 与 service，不提供命令或租约。
 */
export function peekReadOnlyState(service, projectId) {
  let state;
  try {
    state = service.peekProjectState(projectId);
  } catch {
    throw new BoardError('store-unavailable', 'project state is not readable', { status: 503 });
  }
  if (!state) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
  return { id: projectId, state, service, readOnly: true, closed: false };
}
const TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
]);
const IMAGE_LINE = /^\s{0,3}!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const FENCE_LINE = /^\s{0,3}\x60{3,}/;

/** 只接受文档目录下的相对路径；拒绝本机路径、空段与不可见控制字符。 */
function safeRelative(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') return null;
  if (/[\\:\x00-\x1f\x7f-\x9f]/.test(rawPath)) return null;
  if (path.posix.isAbsolute(rawPath)) return null;
  if (rawPath.split('/').some((part) => part === '')) return null;
  return rawPath;
}

/** 把正文引用解析成 binding 根内路径；区分词法非法与越界两种拒绝。 */
function resolveReference(docRelPath, rawPath) {
  const safe = safeRelative(rawPath);
  if (!safe) return { code: 'security-rejected' };
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(docRelPath), safe));
  if (resolved === '..' || resolved.startsWith('../')) return { code: 'outside-root' };
  return { path: resolved };
}

// 只有独占一行的图片语法算引用；围栏代码块里的同形文本不是图片。
function referencedPaths(docRelPath, text) {
  const paths = new Set();
  let fenced = false;
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = line.match(IMAGE_LINE);
    if (!match) continue;
    const target = resolveReference(docRelPath, match[2]);
    if (target.path) paths.add(target.path);
  }
  return paths;
}

/**
 * 读取外置文档正文引用的一张图片。
 *
 * 路径先按文档目录解析并限制在 binding 根内；只有正文独占一行图片语法引用、
 * 且扩展名在白名单内的文件才可读。每次请求都重读正文、不引入图片缓存：
 * 正文变化后旧引用立即失效，代价是一次有界文档读取。错误只返回分类，不泄露本机路径。
 */
export function readImageAsset(handle, docId, rawPath) {
  const doc = handle.state.docs[docId];
  if (!doc || doc.source !== 'external' || !doc.locator) {
    throw new BoardError('not-found', 'external document not found', { status: 404 });
  }
  const docRelPath = doc.locator.relPath;
  const target = resolveReference(docRelPath, rawPath);
  if (!target.path) {
    const code = target.code === 'outside-root' ? 'outside-root' : 'security-rejected';
    throw new BoardError(code, code === 'outside-root' ? 'image is outside the binding root' : 'invalid relative image path', { status: 403 });
  }
  const resolved = target.path;
  reloadBindings(handle);
  const { read: body } = readLocator(handle, { bindingId: doc.locator.bindingId, relPath: docRelPath });
  if (!body.ok) throw readFailure(body);
  if (!referencedPaths(docRelPath, body.text).has(resolved)) {
    throw new BoardError('not-found', 'image is not referenced by the document', { status: 404 });
  }
  const contentType = TYPES.get(path.posix.extname(resolved).toLowerCase());
  if (!contentType) throw new BoardError('unsupported-format', 'image format is not supported', { status: 415 });
  // 物理路径、链接与读取上限复用文档安全域；错误仅返回分类，不泄露本机绝对路径。
  const { read } = readLocator(handle, { bindingId: doc.locator.bindingId, relPath: resolved }, { includeBytes: true, maxBytes: IMAGE_MAX_BYTES });
  if (!read.ok) throw readFailure(read);
  if (!read.bytes) throw new BoardError('unsupported-format', 'image bytes are unavailable', { status: 415 });
  return { bytes: read.bytes, contentType, size: read.size, hash: read.hash };
}
