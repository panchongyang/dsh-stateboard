import { BoardError } from '../errors.js';

export function updateProjectPhase(project, phase) {
  if (!['active', 'paused', 'archived'].includes(phase)) return project;
  if (!['active', 'paused', 'archived'].includes(project.phase)) throw new BoardError('illegal-transition', 'unknown project phase', { status: 409 });
  project.phase = phase;
  return project;
}
