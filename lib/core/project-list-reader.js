// Project-list reads are display projections, never authority for a write gate.
// Active writers already own a validated projection. Cold/foreign projects are
// validated in a worker; unchanged files reuse only their small summary.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { progressOf } from './model.js';

// Shared across service instances/plugin reloads, not just per HTTP caller.
const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
const waiting = new Set();
let active = 0;
function pump() {
  while (active < MAX_ACTIVE && waiting.size) waiting.values().next().value();
}

export function projectSummary(id, state, rev, readOnly = false) {
  return { id, name: state.project.name, workspacePath: state.project.workspacePath,
    phase: state.project.phase, rev, counts: progressOf(state),
    lastAt: state.project.updatedAt, readOnly };
}

export function projectListError(id, error) {
  return { id, name: id, workspacePath: '', phase: 'unknown', rev: 0,
    error: error instanceof Error ? error.message : String(error) };
}

export function sortProjectList(rows) {
  return rows.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}

async function fingerprint(dir) {
  const parts = [];
  for (const name of ['meta.json', 'commits.jsonl', 'snapshot.json']) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name), { bigint: true });
      parts.push([name, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      parts.push(name + ':missing');
    }
  }
  return parts.join('|');
}

export class ProjectListReader {
  constructor(service, lookupHandle = (id) => service.handles.get(id)) {
    this.service = service;
    this.lookupHandle = lookupHandle;
    this.cache = new Map();
    this.liveCache = new WeakMap();
    this.pending = null;
    this.cancel = null;
    this.closed = false;
    this.metrics = { requests: 0, coalesced: 0, liveHits: 0, cacheHits: 0, replayRequests: 0 };
  }

  live(id) {
    const handle = this.lookupHandle(id);
    // A foreign writer can append behind a read-only handle. Never present that
    // handle's stale state as a fresh list result.
    if (!handle || handle.closed || handle.readOnly || handle.store?.readOnly) return null;
    let cached = this.liveCache.get(handle);
    if (!cached || cached.rev !== handle.rev) {
      cached = { rev: handle.rev, row: projectSummary(id, handle.state, handle.rev) };
      this.liveCache.set(handle, cached);
    }
    this.metrics.liveHits += 1;
    return structuredClone(cached.row);
  }

  list() {
    if (this.closed) return Promise.reject(new Error('project list reader is closed'));
    this.metrics.requests += 1;
    if (this.pending) this.metrics.coalesced += 1;
    else {
      const pending = this.collect();
      this.pending = pending;
      const clear = () => { if (this.pending === pending) this.pending = null; };
      pending.then(clear, clear);
    }
    // Check at publication too: even a purely hot list yields a microtask turn.
    // Do not let a caller mutate a shared flight or cache entry.
    return this.pending.then((rows) => {
      if (this.closed) throw new Error('project list reader is closed');
      return structuredClone(rows);
    });
  }

  async collect() {
    const rows = [];
    const cold = [];
    for (const [id, meta] of this.service.metas) {
      if (this.closed) throw new Error('project list reader is closed');
      const live = this.live(id);
      if (live) { rows.push(live); this.cache.delete(id); continue; }
      const dir = path.join(this.service.projectsDir, id);
      try {
        const key = await fingerprint(dir);
        const cached = this.cache.get(id);
        if (cached?.key === key) {
          this.metrics.cacheHits += 1;
          rows.push(structuredClone(cached.row));
        } else cold.push({ id, dir, meta, key });
      } catch (error) { this.cache.delete(id); rows.push(projectListError(id, error)); }
    }
    for (const id of this.cache.keys()) if (!this.service.metas.has(id)) this.cache.delete(id);
    if (cold.length) {
      const results = await this.replay(cold);
      for (let index = 0; index < cold.length; index += 1) {
        const entry = cold[index];
        let row = results[index];
        try {
          // A list must not memoize a projection read during a concurrent append
          // or replace. Report transient uncertainty; the next poll retries.
          const after = await fingerprint(entry.dir);
          if (entry.key !== after) row = projectListError(entry.id, 'project changed during listing; retry');
          else if (!row.error && !this.closed) this.cache.set(entry.id, { key: after, row });
        } catch (error) { row = projectListError(entry.id, error); }
        if (row.error) this.cache.delete(entry.id);
        rows.push(row);
      }
    }
    if (this.closed) throw new Error('project list reader is closed');
    return sortProjectList(rows);
  }

  replay(entries) {
    if (this.closed) return Promise.reject(new Error('project list reader is closed'));
    if (waiting.size >= MAX_QUEUED) return Promise.reject(new Error('project listing busy; retry later'));
    // One coalesced flight per service plus a process-wide bound. Queue time is
    // included in the deadline, and a slot survives until its worker is stopped.
    return new Promise((resolve, reject) => {
      let worker;
      let running = false;
      let settled = false;
      let stopping;
      const finish = (error, rows) => {
        if (settled) return stopping;
        settled = true;
        clearTimeout(timer);
        waiting.delete(start);
        const stopped = worker ? worker.terminate() : Promise.resolve();
        stopping = stopped.catch((terminationError) => { error ||= terminationError; }).then(() => {
          this.cancel = null;
          if (running) active -= 1;
          if (this.closed) error = new Error('project list reader is closed');
          if (error) reject(error); else resolve(rows);
          pump();
        });
        return stopping;
      };
      const start = () => {
        waiting.delete(start);
        if (settled) return;
        running = true;
        active += 1;
        this.metrics.replayRequests += entries.length;
        try {
          worker = new Worker(new URL('./project-list-worker.js', import.meta.url), {
            workerData: entries.map(({ id, dir }) => ({ id, dir })),
            resourceLimits: { maxOldGenerationSizeMb: 256 },
          });
          worker.once('message', (rows) => finish(null, rows));
          worker.once('error', (error) => finish(error));
          worker.once('exit', (code) => { if (!settled) finish(new Error('project listing worker exited: ' + code)); });
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('project listing exceeded 30s budget')), 30_000);
      this.cancel = () => finish(new Error('project list reader is closed'));
      waiting.add(start);
      pump();
    });
  }

  close() {
    this.closed = true;
    const stopping = this.cancel?.();
    this.cache.clear();
    return stopping;
  }
}
