import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON } from '../util.js';
import { metadataOf, searchGroup } from './records.js';
import { ftsText, ftsQuery } from './terms.js';

const FORMAT = 'knowledge/1/terms-3';

// 按词组收集 FTS 命中、按实体折叠并取页，完整元数据只在末尾回表读取。
function searchMatches(db, query, kinds, count, offset, { historyGroup, relaxed } = {}) {
  const filters = [], params = [];
  if (kinds.length) {
    filters.push("json_extract(sources.metadata,'$.kind') IN (" + kinds.map(() => '?').join(',') + ')');
    params.push(...kinds);
  }
  if (historyGroup) {
    filters.push('knowledge_group(sources.metadata) = ?');
    params.push(historyGroup);
  }
  const filter = filters.length ? ' AND ' + filters.join(' AND ') : '';
  const groups = relaxed?.groups ?? [query];
  const clause = `SELECT matches.rowid AS rid, bm25(matches,3,1) AS score, ? AS bit
    FROM matches JOIN sources ON sources.rowid=matches.rowid WHERE matches MATCH ?${filter}`;
  const matches = groups.map(() => clause).join(' UNION ALL ');
  const minimum = relaxed?.minimum ?? 1;
  const groupKey = historyGroup ? 'rid' : 'knowledge_group(metadata)';
  const sql = `WITH scores AS MATERIALIZED (${matches}),
    ranked AS (SELECT rid, min(score) AS score, count(*) AS groupMatches, sum(bit) AS groupMask
      FROM scores GROUP BY rid HAVING count(*) >= ?),
    grouped AS MATERIALIZED (SELECT ranked.*, ${groupKey} AS entityKey
      FROM ranked JOIN sources ON sources.rowid=rid),
    ordered AS (SELECT grouped.*,
      count(*) OVER (PARTITION BY entityKey) AS historyCount,
      max(groupMatches) OVER (PARTITION BY entityKey) AS bestCoverage,
      first_value(score) OVER (PARTITION BY entityKey ORDER BY groupMatches DESC, score) AS bestScore,
      row_number() OVER (PARTITION BY entityKey ORDER BY rid DESC) AS latest
      FROM grouped),
    page AS (SELECT rid, score, historyCount, groupMask, bestCoverage, bestScore
      FROM ordered WHERE latest=1 ORDER BY bestCoverage DESC, bestScore, rid DESC LIMIT ? OFFSET ?)
    SELECT metadata, score, historyCount, groupMask FROM page JOIN sources ON sources.rowid=rid
    ORDER BY bestCoverage DESC, bestScore, rid DESC`;
  const inputs = groups.flatMap((group, i) => [1 << i, ftsQuery(group), ...params]);
  return db.prepare(sql).all(...inputs, minimum, count, offset).map(({ metadata, score, historyCount, groupMask }) => {
    return { ...JSON.parse(metadata), score, historyCount, groupMask };
  });
}

function safeDirectory(root) {
  const parent = fs.realpathSync(root);
  const dir = path.join(parent, 'knowledge-cache');
  const before = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (before && (!before.isDirectory() || before.isSymbolicLink())) throw new Error('unsafe cache');
  if (!before) fs.mkdirSync(dir, { mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error('unsafe cache');
  return dir;
}

function cacheFile(root, projectId) {
  const file = path.join(safeDirectory(root), projectId + '.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stat = fs.lstatSync(file + suffix, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('unsafe cache file');
  }
  return file;
}

function initialize(db) {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sources (rowid INTEGER PRIMARY KEY, sid TEXT UNIQUE NOT NULL, origin TEXT, metadata TEXT NOT NULL)');
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS matches USING fts5(title, body, content='', contentless_delete=1)");
}

// 用途：SQLite 仅作为派生缓存；能力/缓存故障退回扫描，禁止动态加载外部扩展。
export async function openKnowledgeIndex(root, projectId, { disableSqlite = false } = {}) {
  if (disableSqlite) return { engine: 'scan', reason: 'sqlite-unavailable' };
  let db, file;
  try {
    const sqlite = await import('node:sqlite');
    const Database = sqlite.DatabaseSync || sqlite.Database;
    file = cacheFile(root, projectId);
    try {
      db = new Database(file, { allowExtension: false });
      initialize(db);
    } catch (error) {
      try { db?.close(); } catch { /* unusable cache */ }
      if (/busy|locked/i.test(error.message)) throw error;
      if (fs.existsSync(file)) fs.renameSync(file, file + '.invalid-' + randomUUID());
      db = new Database(file, { allowExtension: false });
      initialize(db);
    }
    return createIndex(db, file, projectId);
  } catch {
    try { db?.close(); } catch { /* fallback must remain available */ }
    return { engine: 'scan', reason: 'index-unavailable' };
  }
}

// 用途：封装固定 SQL，索引不持久化原文；数据和进度只在同一独立事务中发布。
function createIndex(db, file, projectId) {
  db.function('knowledge_group', { deterministic: true }, metadata => searchGroup(JSON.parse(metadata), projectId));
  let closed = false;
  const close = () => { if (!closed) { closed = true; db.close(); } };
  const get = key => { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  const remove = origin => {
    const rows = db.prepare('SELECT rowid FROM sources WHERE origin=?').all(origin);
    for (const row of rows) db.prepare('DELETE FROM matches WHERE rowid=?').run(row.rowid);
    db.prepare('DELETE FROM sources WHERE origin=?').run(origin);
    return rows.length > 0;
  };
  return {
    engine: 'fts5', get, set, close,
    invalidate() { close(); try { fs.renameSync(file, file + '.invalid-' + randomUUID()); } catch { /* degraded read remains usable */ } },
    begin: () => db.exec('BEGIN IMMEDIATE'), beginRead: () => db.exec('BEGIN'),
    commit: () => db.exec('COMMIT'), rollback: () => db.exec('ROLLBACK'),
    reset() {
      db.exec('DELETE FROM matches; DELETE FROM sources; DELETE FROM meta;');
      set('format', FORMAT); set('generation', randomUUID());
    },
    compatible: () => get('format') === FORMAT,
    publish: () => set('generation', randomUUID()),
    remove,
    byOrigin: origin => db.prepare('SELECT metadata FROM sources WHERE origin=?').all(origin).map(row => JSON.parse(row.metadata)),
    origins: () => db.prepare('SELECT DISTINCT origin FROM sources WHERE origin IS NOT NULL').all().map(row => row.origin),
    put(source) {
      const metadata = canonicalJSON(metadataOf(source));
      const previous = db.prepare('SELECT rowid,metadata FROM sources WHERE sid=?').get(source.id);
      if (previous?.metadata === metadata) return false;
      db.prepare('INSERT INTO sources(sid,origin,metadata) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET metadata=excluded.metadata,origin=excluded.origin')
        .run(source.id, source.origin || null, metadata);
      const { rowid } = db.prepare('SELECT rowid FROM sources WHERE sid=?').get(source.id);
      db.prepare('INSERT OR REPLACE INTO matches(rowid,title,body) VALUES(?,?,?)').run(rowid, ftsText(source.title), ftsText(source.text || ''));
      return true;
    },
    search: (query, kinds, count, offset, options) => searchMatches(db, query, kinds, count, offset, options),
    count: () => db.prepare('SELECT count(*) AS n FROM sources').get().n,
  };
}
