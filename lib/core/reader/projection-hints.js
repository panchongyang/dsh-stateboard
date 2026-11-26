// A root-only watcher is a hint, never a permission or freshness proof. One
// budgeted page at a time; periodic compensation also works without a watcher.
import { watch } from 'node:fs';
const PERIOD = 60_000, COOL_DOWN = 5_000, ACTIVE_WINDOW = 180_000;

class ProjectionHints {
  constructor({watchRoot = watch, timer = setTimeout, now = Date.now} = {}) {
    this.rows = new Map(); this.watchRoot = watchRoot; this.timer = timer; this.now = now;
  }
  stop(row) {
    row.closed = true; clearTimeout(row.timer); row.watcher?.close();
    if (this.rows.get(row.key) === row) this.rows.delete(row.key);
  }
  schedule(row, delay) {
    if (row.closed) return;
    clearTimeout(row.timer);
    row.timer = this.timer(() => this.tick(row),delay).unref();
  }
  attach(row) {
    try {
      row.watcher = this.watchRoot(row.root,{persistent:false},() => {
        if (!row.running && !row.cursor && !row.closed && !row.dirty) {
          row.dirty = true; this.schedule(row,Math.max(500,COOL_DOWN - (this.now() - row.last)));
        }
      });
      row.watcher.on('error',() => { row.watcher?.close(); row.watchState = 'unavailable'; });
      row.watchState = 'root-hints';
    } catch { row.watchState = 'unavailable'; }
  }
  async tick(row) {
    if (row.closed || row.running) return;
    if (this.now() - row.touched > ACTIVE_WINDOW) return this.stop(row);
    let checked = false, restart = false;
    try {
      row.running = true; row.last = this.now();
      // A pending timer is not a capability, even for attaching a watcher.
      await row.check(); checked = true;
      if (row.closed) return;
      if (row.watchState === 'pending') this.attach(row);
      row.dirty = false;
      const page = await row.scan(row.cursor);
      row.cursor = page.partial ? page.nextCursor : null;
    } catch (e) {
      if (!checked || ['project-forbidden','forbidden-role','space-home-unavailable','not-found','closed','handle-closed'].includes(e?.code)) return this.stop(row);
      // The authority is still current, but a partial stream can expire, e.g.
      // after an ignore change. Drop that cursor, not the entire compensation job.
      restart = e?.code === 'restart-required';
      if (e?.code !== 'projection-busy') row.cursor = null;
    } finally { row.running = false; }
    if (!row.closed) this.schedule(row,restart ? COOL_DOWN : row.cursor ? 1000 : PERIOD);
  }
  hint({owner,key,root,check,scan}, {alreadyScanning = false} = {}) {
    const prior = this.rows.get(key);
    if (prior) { prior.touched = this.now(); prior.check = check; prior.scan = scan; return; }
    if (this.rows.size >= 4) this.stop([...this.rows.values()].sort((a,b) => a.touched-b.touched)[0]);
    const row = {owner,key,root,check,scan,touched:this.now(),last:0,watchState:'pending',cursor:null};
    this.rows.set(key,row); this.schedule(row,alreadyScanning ? PERIOD : 500);
  }
  status(key) { return this.rows.get(key)?.watchState ?? 'not-attached'; }
  close(owner) { for (const row of this.rows.values()) if (row.owner === owner) this.stop(row); }
}
export const createProjectionHints = options => new ProjectionHints(options);
export const workspaceHints = createProjectionHints();
