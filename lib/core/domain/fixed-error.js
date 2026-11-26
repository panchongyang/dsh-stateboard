// 固定引用的错误分类仅取决于值；回放无需装入 Git 或文件读取器。
import { BoardError } from '../errors.js';

export function fixedError(code, message, details = null) {
  const status = { 'fixed-object-missing': 404, 'fixed-path-missing': 404, 'unsupported-repository': 422, 'unsupported-content-transform': 422, 'invalid-fixed-reference': 400, 'unsupported-format': 400, oversize: 413, 'git-unavailable': 503 }[code] || 409;
  return new BoardError(code, message, { status, details });
}
