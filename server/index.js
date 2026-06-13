// server/index.js — Tank Mission Control
import express from 'express';
import { WebSocketServer } from 'ws';
import { exec, execSync } from 'child_process';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client', 'dist');

const app = express();
app.use(express.json());

// ── TOKEN AUTH ─────────────────────────────────────────────────────
const TANK_TOKEN = process.env.TANK_TOKEN;
if (!TANK_TOKEN) {
  console.error('❌ TANK_TOKEN environment variable is required. Set it before starting Tank.');
  console.error('   Example: TANK_TOKEN=your-secret-token node server/index.js');
  process.exit(1);
}

function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  if (cookie.includes('tank_auth=' + TANK_TOKEN)) return true;
  if (req.headers.authorization === 'Bearer ' + TANK_TOKEN) return true;
  // Check query param for WS connections
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('token') === TANK_TOKEN) return true;
  return false;
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ── DATABASE ──────────────────────────────────────────────────────
const db = new Database(path.join(ROOT, 'tank.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT,
    icon TEXT DEFAULT '🚀', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    prompt TEXT, status TEXT DEFAULT 'pending', tmux_session TEXT,
    model TEXT DEFAULT 'opus', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME, FOREIGN KEY (project_id) REFERENCES projects(id)
  );
`);

// ── TMUX ───────────────────────────────────────────────────────────
function createTmuxSession(taskId, workdir, model) {
  const sessionName = `tank-${taskId.slice(0, 8)}`;
  const modelFlag = model && model !== 'opus' ? `--model ${model}` : '';
  const baseCmd = `claude --dangerously-skip-permissions${modelFlag ? ' ' + modelFlag : ''}`;
  exec(`tmux new-session -d -s ${sessionName} -c ${workdir || ROOT} 2>&1`, (err) => {
    if (err) console.error('tmux create error:', err);
    exec(`tmux send-keys -t ${sessionName} "${baseCmd}" Enter 2>&1`, (err2) => {
      if (err2) console.error('tmux send-keys error:', err2);
    });
    setTimeout(() => {
      exec(`tmux send-keys -t ${sessionName} "1" Enter 2>&1`);
    }, 4000);
  });
  return sessionName;
}

function getTmuxOutput(sessionName) {
  return new Promise((resolve) => {
    exec(`tmux capture-pane -t ${sessionName} -p -S -50 2>&1`, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function sendToSession(sessionName, text) {
  exec(`tmux send-keys -t ${sessionName} -- "${text.replace(/"/g, '\\"')}" Enter 2>&1`);
}

function killTmuxSession(sessionName) {
  exec(`tmux kill-session -t ${sessionName} 2>&1`);
}

// ── STATIC FILES (public, no auth) ─────────────────────────────────
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
}

// ── AUTH ENDPOINTS ─────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.token === TANK_TOKEN) {
    res.setHeader('Set-Cookie',
      `tank_auth=${TANK_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'bad token' });
  }
});

app.get('/api/auth', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

// ── PROTECTED API ──────────────────────────────────────────────────
app.use('/api/projects', requireAuth);
app.use('/api/tasks', requireAuth);
app.use('/api/flatten', requireAuth);
app.use('/api/todos', requireAuth);

// Projects
app.get('/api/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all());
});

app.post('/api/projects', (req, res) => {
  const { name, repo_path, icon } = req.body;
  const id = uuid();
  db.prepare('INSERT INTO projects (id, name, repo_path, icon) VALUES (?, ?, ?, ?)')
    .run(id, name, repo_path, icon || '🚀');
  res.json({ id, name, repo_path, icon: icon || '🚀' });
});

// Tasks
app.get('/api/tasks/:projectId', (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId));
});

app.post('/api/tasks', async (req, res) => {
  const { project_id, title, prompt, model = 'opus', repo_path } = req.body;
  const id = uuid();
  const workdir = repo_path || ROOT;

  db.prepare('INSERT INTO tasks (id, project_id, title, prompt, status, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, project_id, title, prompt, 'running', model);

  const sessionName = createTmuxSession(id, workdir, model);
  db.prepare('UPDATE tasks SET tmux_session = ? WHERE id = ?').run(sessionName, id);
  db.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(project_id);

  setTimeout(() => { if (prompt) sendToSession(sessionName, prompt); }, 8000);

  res.json({ id, title, status: 'running', tmux_session: sessionName });
});

app.get('/api/tasks/:taskId/output', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not found' });
  const output = task.tmux_session ? await getTmuxOutput(task.tmux_session) : '';
  res.json({ output, status: task.status });
});

app.post('/api/tasks/:taskId/input', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task?.tmux_session) return res.status(404).json({ error: 'not running' });
  sendToSession(task.tmux_session, req.body.text);
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/complete', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (task?.tmux_session) killTmuxSession(task.tmux_session);
  db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('completed', req.params.taskId);
  res.json({ ok: true });
});

// Flatten repo
app.get('/api/flatten/:projectId', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project?.repo_path) return res.status(400).json({ error: 'No repo path' });
  try {
    const result = execSync(
      `find ${project.repo_path} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/venv/*' | head -200 | while read f; do echo "=== $f ==="; cat "$f"; echo; done`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 30000 }
    ).toString();
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name}-flat.txt"`);
    res.send(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SPA FALLBACK ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// ── START SERVER ───────────────────────────────────────────────────
const PORT = process.env.PORT || 7878;
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tank Mission Control running on port ${PORT}`);
});

// ── WEBSOCKETS ────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (!isAuthed(req)) {
    ws.close(1008, 'unauthorized');
    return;
  }

  ws.isAlive = true;
  ws.taskId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'listen_task') {
        ws.taskId = msg.taskId;
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(msg.taskId);
        if (task?.tmux_session) {
          const output = await getTmuxOutput(task.tmux_session);
          ws.send(JSON.stringify({ type: 'task_output', taskId: msg.taskId, output }));
        }
      }
      if (msg.type === 'task_input') {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(msg.taskId);
        if (task?.tmux_session) sendToSession(task.tmux_session, msg.text);
      }
    } catch (e) { console.error('ws error:', e); }
  });
});

// Poll running tasks and broadcast
setInterval(async () => {
  const running = db.prepare("SELECT * FROM tasks WHERE status = 'running' AND tmux_session IS NOT NULL").all();
  for (const task of running) {
    const output = await getTmuxOutput(task.tmux_session);
    wss.clients.forEach((ws) => {
      if (ws.taskId === task.id && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'task_output', taskId: task.id, output }));
      }
    });
  }
}, 1500);
