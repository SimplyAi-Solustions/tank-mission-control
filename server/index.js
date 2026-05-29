// server/index.js — Tank Mission Control
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn, exec } from 'child_process';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client', 'dist');

const app = express();
app.use(express.json());

// ── DATABASE ──────────────────────────────────────────────────────
const db = new Database(path.join(ROOT, 'tank.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT,
    icon TEXT DEFAULT '🚀',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT,
    status TEXT DEFAULT 'pending',
    tmux_session TEXT,
    model TEXT DEFAULT 'sonnet',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS task_output (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── TMUX SESSIONS ─────────────────────────────────────────────────
const activeSessions = new Map(); // task_id -> { ws, tmux, tail }

function createTmuxSession(taskId, workdir) {
  const sessionName = `tank-${taskId.slice(0, 8)}`;
  
  // Create detached tmux session
  exec(`tmux new-session -d -s ${sessionName} -c ${workdir || ROOT} 2>&1`, (err) => {
    if (err) console.error(`tmux create error: ${err}`);
    
    // Launch Claude Code interactively in that session
    exec(`tmux send-keys -t ${sessionName} "claude" Enter 2>&1`, (err2) => {
      if (err2) console.error(`tmux send-keys error: ${err2}`);
    });
  });

  return sessionName;
}

function getTmuxOutput(sessionName) {
  return new Promise((resolve) => {
    exec(`tmux capture-pane -t ${sessionName} -p -S -50 2>&1`, (err, stdout) => {
      if (err) resolve('');
      else resolve(stdout);
    });
  });
}

function sendToSession(sessionName, text) {
  exec(`tmux send-keys -t ${sessionName} -- "${text.replace(/"/g, '\\"')}" 2>&1`);
}

function killTmuxSession(sessionName) {
  exec(`tmux kill-session -t ${sessionName} 2>&1`);
}

// ── API ROUTES ─────────────────────────────────────────────────────

// Get all projects
app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  res.json(projects);
});

// Create project
app.post('/api/projects', (req, res) => {
  const { name, repo_path, icon } = req.body;
  const id = uuid();
  db.prepare('INSERT INTO projects (id, name, repo_path, icon) VALUES (?, ?, ?, ?)').run(id, name, repo_path, icon || '🚀');
  res.json({ id, name, repo_path, icon: icon || '🚀' });
});

// Get tasks for a project
app.get('/api/tasks/:projectId', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json(tasks);
});

// Create a task and launch Claude Code
app.post('/api/tasks', async (req, res) => {
  const { project_id, title, prompt, model = 'sonnet', repo_path } = req.body;
  const id = uuid();
  
  // Determine working directory
  const workdir = repo_path || ROOT;
  
  // Create task in DB
  db.prepare('INSERT INTO tasks (id, project_id, title, prompt, status, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, project_id, title, prompt, 'running', model);
  
  // Create tmux session with Claude Code
  const sessionName = createTmuxSession(id, workdir);
  
  // Update task with tmux session name
  db.prepare('UPDATE tasks SET tmux_session = ? WHERE id = ?').run(sessionName, id);
  
  // Update project timestamp
  db.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(project_id);

  // Wait a moment then send the prompt
  setTimeout(() => {
    if (prompt) sendToSession(sessionName, prompt);
  }, 2000);

  res.json({ id, title, status: 'running', tmux_session: sessionName });
});

// Get task output
app.get('/api/tasks/:taskId/output', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  
  let output = '';
  if (task.tmux_session) {
    output = await getTmuxOutput(task.tmux_session);
  }
  
  res.json({ output, status: task.status });
});

// Send input to a running task
app.post('/api/tasks/:taskId/input', (req, res) => {
  const { text } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  
  if (!task || !task.tmux_session) {
    return res.status(404).json({ error: 'Task not running' });
  }
  
  sendToSession(task.tmux_session, text);
  res.json({ ok: true });
});

// Complete a task
app.post('/api/tasks/:taskId/complete', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (task?.tmux_session) killTmuxSession(task.tmux_session);
  
  db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('completed', req.params.taskId);
  res.json({ ok: true });
});

// Get todos
app.get('/api/todos/:projectId', (req, res) => {
  const todos = db.prepare('SELECT * FROM todos WHERE project_id = ? ORDER BY created_at').all(req.params.projectId);
  res.json(todos);
});

// Add todo
app.post('/api/todos', (req, res) => {
  const { project_id, text } = req.body;
  const id = uuid();
  db.prepare('INSERT INTO todos (id, project_id, text) VALUES (?, ?, ?)').run(id, project_id, text);
  res.json({ id, text, done: 0 });
});

// Toggle todo
app.post('/api/todos/:todoId/toggle', (req, res) => {
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.todoId);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(todo.done ? 0 : 1, req.params.todoId);
  res.json({ ok: true });
});

// Flatten repo to text file
app.get('/api/flatten/:projectId', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project?.repo_path) return res.status(400).json({ error: 'No repo path' });
  
  const { execSync } = require('child_process');
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

// ── SERVE STATIC CLIENT ───────────────────────────────────────────
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
}

// ── START ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7878;
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`🔥 Tank Mission Control running on port ${PORT}`);
});

// ── WEBSOCKETS ────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'listen_task') {
        // Stream tmux output to this client
        ws.taskId = msg.taskId;
        ws.send(JSON.stringify({ type: 'listening', taskId: msg.taskId }));
      }
      
      if (msg.type === 'task_input') {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(msg.taskId);
        if (task?.tmux_session) {
          sendToSession(task.tmux_session, msg.text);
        }
      }
    } catch (e) {
      console.error('ws message error:', e);
    }
  });
});

// Poll running tasks and broadcast output
setInterval(async () => {
  const running = db.prepare("SELECT * FROM tasks WHERE status = 'running' AND tmux_session IS NOT NULL").all();
  
  for (const task of running) {
    const output = await getTmuxOutput(task.tmux_session);
    
    wss.clients.forEach((ws) => {
      if (ws.taskId === task.id && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'task_output',
          taskId: task.id,
          output
        }));
      }
    });
  }
}, 1500);
