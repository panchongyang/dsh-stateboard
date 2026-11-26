// A process-wide lane, not one lane per session/worktree. Ordinary ProjectService
// commands never enter this queue. Derived state lives exclusively in the worker.
import { Worker } from 'node:worker_threads';
import { BoardError } from '../errors.js';

const unavailable = (code, message) => new BoardError(code, message, {status:503});
const busy = () => unavailable('projection-busy','Discovery is busy; retry later');
const closed = () => unavailable('closed','Document projection has closed');
const url = new URL('./projection-worker.js',import.meta.url);
const makeDefault = () => new Worker(url,{resourceLimits:{maxOldGenerationSizeMb:128}});

class ProjectionPool {
  constructor({makeWorker = makeDefault, timeoutMs = 2000} = {}) {
    this.makeWorker = makeWorker; this.timeoutMs = timeoutMs;
    this.queue = []; this.same = new Map(); this.releases = new Map(); this.sequence = 0;
  }
  finish(job,error,result) {
    clearTimeout(job.timer); this.same.delete(job.key);
    if (error) job.reject(error); else job.resolve(result);
  }
  drained() {
    for (const resolve of this.releases.values()) resolve();
    this.releases.clear();
  }
  retire() {
    clearTimeout(this.idleTimer);
    if (!this.worker) return this.stopping;
    const old = this.worker; this.worker = null;
    // Do not start a second thread while a slow filesystem operation is stopping.
    this.stopping = old.terminate().catch(() => {}).finally(() => { this.drained(); this.stopping = null; this.pump(); });
    old.unref();
    return this.stopping;
  }
  stopJob(error) {
    const job = this.active; this.active = null;
    if (!this.retire()) setImmediate(() => this.pump());
    if (job) this.finish(job,error);
  }
  startWorker() {
    const w = this.makeWorker(); this.worker = w;
    w.on('message',msg => {
      if (w !== this.worker) return;
      if (msg.released) {
        const done = this.releases.get(msg.released); this.releases.delete(msg.released);
        if (msg.empty && !this.active && !this.queue.length) done?.(this.retire());
        else { done?.(); this.pump(); }
        return;
      }
      if (!this.active || msg.id !== this.active.id) return;
      const job = this.active; this.active = null;
      const e = msg.error;
      this.finish(job,e && new BoardError(e.code,e.message,{status:e.status}),msg.result);
      setImmediate(() => this.pump());
    });
    w.on('error',() => {if (w === this.worker) this.stopJob(unavailable('projection-unavailable','Document worker failed'));});
    w.on('exit',() => {
      if (w !== this.worker) return;
      this.worker = null; this.drained();
      if (this.active) {const job = this.active; this.active = null; this.finish(job,unavailable('projection-unavailable','Document worker exited'));}
      this.pump();
    });
    return w;
  }
  pump() {
    if (this.active || this.stopping) return;
    clearTimeout(this.idleTimer);
    const job = this.queue.shift();
    if (!job) {
      if (this.worker && !this.releases.size) {
        this.worker.unref(); this.idleTimer = setTimeout(() => this.retire(),90_000).unref();
      }
      return;
    }
    this.active = job; clearTimeout(job.timer);
    job.timer = setTimeout(() => this.stopJob(unavailable('projection-timeout','Document batch timed out; restart discovery')),this.timeoutMs);
    Promise.resolve().then(() => job.check?.()).then(() => {
      if (this.active !== job) return;
      try {
        const worker = this.worker || this.startWorker(); worker.ref();
        worker.postMessage({id:job.id,context:job.context,request:job.request});
      } catch { this.stopJob(unavailable('projection-unavailable','Document worker could not start')); }
    },error => { if (this.active === job) {this.active = null; this.finish(job,error); setImmediate(() => this.pump());} });
  }
  submit(context,request,{background = false,check} = {}) {
    const key = JSON.stringify([context.scopeKey,request.op,request.cursor,request.relPath,request.maxBytes,background]);
    if (this.same.has(key)) return this.same.get(key);
    if (this.queue.length >= 8 || (background && (this.active || this.stopping || this.queue.length))) return Promise.reject(busy());
    const {promise,resolve,reject} = Promise.withResolvers();
    const job = {context,request,key,check,id:++this.sequence,resolve,reject,timer:null};
    this.same.set(key,promise); this.queue.push(job);
    job.timer = setTimeout(() => {
      const at = this.queue.indexOf(job); if (at >= 0) {this.queue.splice(at,1); this.finish(job,busy());}
    },this.timeoutMs);
    this.pump(); return promise;
  }
  async release(owner) {
    // Kernel I/O is not always interruptible. Detach only this read resource;
    // the global slot stays occupied until termination actually completes.
    let timer;
    try { await Promise.race([this.requestRelease(owner),new Promise(resolve => {timer = setTimeout(resolve,100);})]); }
    finally { clearTimeout(timer); }
  }
  requestRelease(owner) {
    for (let n = this.queue.length-1; n >= 0; n--) if (this.queue[n].context.owner === owner) this.finish(this.queue.splice(n,1)[0],closed());
    if (this.active?.context.owner === owner) {this.stopJob(closed()); return this.stopping;}
    if (!this.worker) return;
    clearTimeout(this.idleTimer); this.worker.ref();
    const id = ++this.sequence, {promise,resolve} = Promise.withResolvers();
    this.releases.set(id,resolve); this.worker.postMessage({id,forget:owner});
    return promise;
  }
}
export const createProjectionPool = options => new ProjectionPool(options);
export const workspaceProjectionPool = createProjectionPool();
