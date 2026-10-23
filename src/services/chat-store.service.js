/**
 * Local SQLite chat history (sql.js / WASM — no native rebuild).
 * DB file: ~/.Vysper/chat.db
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const logger = require('../core/logger').createServiceLogger('CHAT_STORE');
const config = require('../core/config');

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function titleFromText(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '新会话';
  return t.length > 36 ? `${t.slice(0, 36)}…` : t;
}

class ChatStoreService {
  constructor() {
    this.db = null;
    this.SQL = null;
    this.dbPath = path.join(config.get('app.dataDir'), 'chat.db');
    this.ready = null;
    this._persistTimer = null;
    this.currentSessionId = null;
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = this._init();
    return this.ready;
  }

  async _init() {
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // sql.js resolves to dist/sql-wasm.js; wasm sits beside it
    const sqlDistDir = path.dirname(require.resolve('sql.js'));
    this.SQL = await initSqlJs({
      locateFile: (file) => path.join(sqlDistDir, file),
    });

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buf);
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新会话',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dsh_session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ui_type TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);
    `);

    this._persist(true);
    logger.info('Chat store ready', { dbPath: this.dbPath });
    return this;
  }

  _persist(immediate = false) {
    const flush = () => {
      this._persistTimer = null;
      try {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
      } catch (error) {
        logger.error('Failed to persist chat.db', { error: error.message });
      }
    };

    if (immediate) {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      flush();
      return;
    }

    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(flush, 200);
  }

  _all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  _get(sql, params = []) {
    const rows = this._all(sql, params);
    return rows[0] || null;
  }

  _run(sql, params = []) {
    this.db.run(sql, params);
  }

  ensureCurrentSession() {
    if (this.currentSessionId) {
      const existing = this._get('SELECT id FROM sessions WHERE id = ?', [
        this.currentSessionId,
      ]);
      if (existing) return this.getSession(this.currentSessionId);
    }

    const latest = this._get(
      'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1'
    );
    if (latest) {
      this.currentSessionId = latest.id;
      return this._mapSession(latest);
    }

    return this.createSession({ title: '新会话' });
  }

  createSession({ title = '新会话', makeCurrent = true } = {}) {
    const id = makeId('sess');
    const ts = nowIso();
    this._run(
      `INSERT INTO sessions (id, title, created_at, updated_at, dsh_session_id)
       VALUES (?, ?, ?, ?, NULL)`,
      [id, title || '新会话', ts, ts]
    );
    this._persist();
    if (makeCurrent) this.currentSessionId = id;
    logger.info('Session created', { id, title });
    return this.getSession(id);
  }

  getSession(sessionId) {
    const row = this._get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    return row ? this._mapSession(row) : null;
  }

  getCurrentSession() {
    if (!this.currentSessionId) return this.ensureCurrentSession();
    return this.getSession(this.currentSessionId);
  }

  listSessions({ limit = 100 } = {}) {
    const rows = this._all(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s
       ORDER BY s.updated_at DESC
       LIMIT ?`,
      [Math.max(1, Math.min(500, Number(limit) || 100))]
    );
    return rows.map((r) => this._mapSession(r));
  }

  _mapSession(row) {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dshSessionId: row.dsh_session_id || null,
      messageCount: Number(row.message_count || 0),
    };
  }

  renameSession(sessionId, title) {
    const next = String(title || '').trim();
    if (!next) return { success: false, error: 'empty-title' };
    const session = this.getSession(sessionId);
    if (!session) return { success: false, error: 'not-found' };
    this._run(
      'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?',
      [next.slice(0, 80), nowIso(), sessionId]
    );
    this._persist();
    return { success: true, session: this.getSession(sessionId) };
  }

  deleteSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return { success: false, error: 'not-found' };

    this._run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
    this._run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    this._persist();

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
      const next = this.listSessions({ limit: 1 })[0];
      if (next) {
        this.currentSessionId = next.id;
      } else {
        this.createSession({ title: '新会话' });
      }
    }

    return {
      success: true,
      deletedId: sessionId,
      currentSessionId: this.currentSessionId,
      currentSession: this.getCurrentSession(),
    };
  }

  setCurrentSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return { success: false, error: 'not-found' };
    this.currentSessionId = sessionId;
    return { success: true, session };
  }

  setDshSessionId(sessionId, dshSessionId) {
    const id = sessionId || this.currentSessionId;
    if (!id) return;
    this._run(
      'UPDATE sessions SET dsh_session_id = ?, updated_at = ? WHERE id = ?',
      [dshSessionId || null, nowIso(), id]
    );
    this._persist();
  }

  addMessage({
    sessionId = null,
    role,
    content,
    uiType = null,
    metadata = null,
    autoTitle = true,
  }) {
    const sid = sessionId || this.currentSessionId;
    if (!sid) throw new Error('No active chat session');

    const text = String(content ?? '');
    if (!text.trim() && role !== 'system') {
      return null;
    }

    const id = makeId('msg');
    const ts = nowIso();
    this._run(
      `INSERT INTO messages (id, session_id, role, content, ui_type, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sid,
        role,
        text,
        uiType || role,
        metadata ? JSON.stringify(metadata) : null,
        ts,
      ]
    );

    this._run('UPDATE sessions SET updated_at = ? WHERE id = ?', [ts, sid]);

    if (autoTitle && (role === 'user' || uiType === 'transcription')) {
      const session = this.getSession(sid);
      if (session && (!session.title || session.title === '新会话')) {
        this._run('UPDATE sessions SET title = ? WHERE id = ?', [
          titleFromText(text),
          sid,
        ]);
      }
    }

    this._persist();
    return {
      id,
      sessionId: sid,
      role,
      content: text,
      uiType: uiType || role,
      metadata: metadata || null,
      createdAt: ts,
    };
  }

  getMessages(sessionId, { limit = 500 } = {}) {
    const sid = sessionId || this.currentSessionId;
    if (!sid) return [];
    const rows = this._all(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [sid, Math.max(1, Math.min(2000, Number(limit) || 500))]
    );
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      uiType: r.ui_type || r.role,
      metadata: r.metadata ? safeJson(r.metadata) : null,
      createdAt: r.created_at,
    }));
  }

  close() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persist(true);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = new ChatStoreService();
