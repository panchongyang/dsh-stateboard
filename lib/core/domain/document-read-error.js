// 只将已观测的失败值分类为契约错误，不读取工作区，也不带入角色政策。
import { BoardError } from '../errors.js';

export function documentReadStatus(code) {
  return { 'root-unavailable': 503, 'missing-binding': 409, 'file-missing': 404, 'permission-denied': 403, 'outside-root': 403, 'security-rejected': 403, 'not-regular': 400, oversize: 413, undecodable: 400, 'unsupported-format': 400, unstable: 409 }[code] || 409;
}

export function readFailure(read) {
  const status = documentReadStatus(read.code);
  return new BoardError(read.code, 'workspace document is not available: ' + read.availability, { status, details: { availability: read.availability, detail: read.detail ?? null } });
}
