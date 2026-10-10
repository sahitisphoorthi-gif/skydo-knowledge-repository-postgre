require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || process.env.APP_PORT || 3000);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

let pool;
async function connectDb() {
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10 }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'kb', password: process.env.DB_PASSWORD || 'kb-local-password', database: process.env.DB_NAME || 'knowledge_repo', ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10 };
  let last;
  for (let i = 1; i <= 60; i++) {
    try {
      pool = new Pool(config);
      await pool.query('SELECT 1');
      await pool.query(`CREATE TABLE IF NOT EXISTS collection_docs (
        collection_name VARCHAR(255) NOT NULL, doc_id VARCHAR(255) NOT NULL, data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (collection_name, doc_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS uploaded_blobs (
        id VARCHAR(64) PRIMARY KEY, original_name VARCHAR(255) NOT NULL, stored_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(255), size_bytes BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      console.log('[db] PostgreSQL connected and schema is ready');
      return;
    } catch (e) {
      last = e;
      if (pool) { try { await pool.end(); } catch {} pool = null; }
      console.log(`[db] waiting for PostgreSQL (${i}/60): ${e.code || e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw last || new Error('Could not connect to PostgreSQL');
}
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB || 50)) * 1024 * 1024 } });
const cleanCollection = s => String(s || '').split('/').filter(Boolean).join('/').slice(0, 255);
const cleanId = s => String(s || '').slice(0, 255);

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});

// Small Firestore-compatible API used by the supplied frontend.
app.get('/api/collections/:collection(*)/doc/:id', async (req, res, next) => {
  try {
    const collection = cleanCollection(req.params.collection), id = cleanId(req.params.id);
    const { rows } = await pool.query('SELECT data FROM collection_docs WHERE collection_name = $1 AND doc_id = $2', [collection, id]);
    res.json(rows.length ? { exists: true, data: typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data } : { exists: false, data: null });
  } catch (e) { next(e); }
});
app.get('/api/collections/:collection(*)', async (req, res, next) => {
  try {
    const collection = cleanCollection(req.params.collection);
    const { rows } = await pool.query('SELECT doc_id, data FROM collection_docs WHERE collection_name = $1 ORDER BY updated_at ASC', [collection]);
    res.json({ docs: rows.map(r => ({ id: r.doc_id, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data })) });
  } catch (e) { next(e); }
});
app.put('/api/collections/:collection(*)/doc/:id', async (req, res, next) => {
  try {
    const collection = cleanCollection(req.params.collection), id = cleanId(req.params.id);
    if (!collection || !id) return res.status(400).json({ error: 'Collection and document ID are required' });
    const data = JSON.stringify(req.body || {});
    await pool.query('INSERT INTO collection_docs (collection_name, doc_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection_name, doc_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()', [collection, id, data]);
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});
app.patch('/api/collections/:collection(*)/doc/:id', async (req, res, next) => {
  try {
    const collection = cleanCollection(req.params.collection), id = cleanId(req.params.id);
    const { rows } = await pool.query('SELECT data FROM collection_docs WHERE collection_name = $1 AND doc_id = $2', [collection, id]);
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    const old = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    await pool.query('UPDATE collection_docs SET data = $1::jsonb, updated_at = NOW() WHERE collection_name = $2 AND doc_id = $3', [JSON.stringify({ ...old, ...(req.body || {}) }), collection, id]);
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});
app.delete('/api/collections/:collection(*)/doc/:id', async (req, res, next) => {
  try { await pool.query('DELETE FROM collection_docs WHERE collection_name = $1 AND doc_id = $2', [cleanCollection(req.params.collection), cleanId(req.params.id)]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post('/api/blobs', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = crypto.randomUUID().replace(/-/g, '');
    const ext = path.extname(req.file.originalname).slice(0, 20);
    const storedName = id + ext;
    const finalPath = path.join(UPLOAD_DIR, storedName);
    fs.renameSync(req.file.path, finalPath);
    await pool.query('INSERT INTO uploaded_blobs (id, original_name, stored_name, mime_type, size_bytes) VALUES ($1, $2, $3, $4, $5)', [id, req.file.originalname, storedName, req.file.mimetype, req.file.size]);
    res.json({ id });
  } catch (e) { next(e); }
});
app.get('/_blob/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM uploaded_blobs WHERE id = $1', [cleanId(req.params.id)]);
    if (!rows.length) return res.status(404).send('File not found');
    const b = rows[0], fp = path.join(UPLOAD_DIR, b.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).send('File is missing from storage');
    res.setHeader('Content-Type', b.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(b.original_name)}`);
    res.sendFile(fp);
  } catch (e) { next(e); }
});
app.delete('/api/blobs/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT stored_name FROM uploaded_blobs WHERE id = $1', [cleanId(req.params.id)]);
    if (rows.length) { const fp = path.join(UPLOAD_DIR, rows[0].stored_name); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await pool.query('DELETE FROM uploaded_blobs WHERE id = $1', [cleanId(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File exceeds ${process.env.MAX_UPLOAD_MB || 50} MB limit` });
  res.status(500).json({ error: 'Server error', detail: process.env.NODE_ENV === 'development' ? err.message : undefined });
});
connectDb().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Knowledge Repository listening on 0.0.0.0:${PORT}`))).catch(e => { console.error('[db] Startup failed:', e); process.exit(1); });
