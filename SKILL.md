---
name: tank-mission-control
description: Operate Tank Mission Control — clone, install, configure, and orchestrate Claude Code in tmux sessions via API/WebSocket. Load this skill whenever setting up Tank on a new VPS, debugging tmux/Claude Code issues, or running multi-task builds via Tank.
category: devops
version: 1.0.0
---

# Tank Mission Control — Agent Skill

## What This Is

Tank is a bridge between an AI agent (you) and Claude Code running inside tmux sessions on a Linux VPS. You use Tank when you need to:

- Run Claude Code as root on a remote VPS (with `--dangerously-skip-permissions`)
- Run multiple Claude Code instances in parallel
- Watch live output from Claude Code as it works
- Send follow-up prompts mid-task
- Kill sessions when done

## Quick Summary

```
You (Hermes agent) → HTTP/WS → Tank server → tmux → Claude Code
```

Tank exposes a REST API and WebSocket. You create projects, spawn tasks (which become tmux sessions running Claude Code), watch output in real time, send input, and close tasks. All via HTTP calls you can make from any code or script.

## Trigger Conditions

Load this skill when:
- Setting up Tank on a fresh VPS
- User asks to "set up Tank" or "install Tank"
- You need to run Claude Code as root via tmux
- A Claude Code task in Tank is failing and you need to debug
- User wants to run multiple Claude Code instances in parallel
- You're building a multi-task workflow that needs tmux isolation

## Prerequisites (check these before anything else)

```bash
# 1. Node.js 20+
node --version

# 2. pnpm
which pnpm || npm install -g pnpm

# 3. tmux
which tmux || apt install -y tmux

# 4. Claude Code CLI at version 2.1.175 (CRITICAL)
claude --version
# If wrong version or not installed:
npm install -g @anthropic-ai/claude-code@2.1.175
```

**Why 2.1.175?** Versions 2.1.176+ block `--dangerously-skip-permissions` when running as root. Tank's tmux sessions run as root, so any newer version will fail silently — tmux session starts, Claude Code refuses to run, no useful error.

## Setup (do this exactly)

### Step 1: Clone the repo

```bash
git clone https://github.com/SimplyAi-Solustions/tank-mission-control.git /opt/tank
cd /opt/tank
```

### Step 2: Install dependencies

```bash
pnpm install
```

### Step 3: Build the client

```bash
cd client && npx vite build && cd ..
```

### Step 4: Generate a token

```bash
TOKEN=$(openssl rand -hex 32)
echo "Generated token: $TOKEN  # SAVE THIS"
```

### Step 5: Start Tank

Choose one:

**Direct:**
```bash
TANK_TOKEN="$TOKEN" node server/index.js &
```

**PM2 (recommended for production):**
```bash
TANK_TOKEN="$TOKEN" pm2 start ecosystem.config.cjs
pm2 save
```

### Step 6: Set up GUI access

Present the user with these 6 options and let them pick:

1. **Localhost** — no setup, works if user can SSH tunnel
2. **Caddy** — reverse proxy with auto HTTPS (recommended for production)
3. **Nginx** — reverse proxy on existing Nginx setup
4. **SSH tunnel** — `ssh -L 7878:127.0.0.1:7878 user@host`
5. **Cloudflare Tunnel** — temporary public URL, no firewall changes
6. **Tailscale Funnel** — private mesh access for Tailscale users

Default: Option 2 (Caddy) for production VPS, Option 1 (localhost) for dev.

Caddy setup:
```bash
apt install -y caddy
echo "tank.DOMAIN.com {
    reverse_proxy 127.0.0.1:7878
}" > /etc/caddy/Caddyfile
systemctl restart caddy
```

### Step 7: Verify

```bash
curl http://127.0.0.1:7878/api/auth
# Should return {"authed":false} — server is alive, just not authed yet

curl -X POST http://127.0.0.1:7878/api/login \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" \
  -c /tmp/tank-cookies

curl http://127.0.0.1:7878/api/projects -b /tmp/tank-cookies
# Should return [] — empty project list, authenticated successfully
```

## Usage Patterns

### Pattern 1: Single task — set and forget

```javascript
// Create project
const proj = await fetch(TANK + '/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ name: 'my-project', repo_path: '/opt/my-project', icon: '🔧' })
}).then(r => r.json());

// Create task (this spawns tmux + Claude Code)
const task = await fetch(TANK + '/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({
    project_id: proj.id,
    title: 'Build auth system',
    prompt: 'Create a complete authentication system with login, signup, password reset. Use bcrypt for hashing and JWT for sessions.',
    model: 'sonnet',
    repo_path: '/opt/my-project'
  })
}).then(r => r.json());

// Poll for completion (Tank returns last 50 lines of tmux pane)
setInterval(async () => {
  const resp = await fetch(`${TANK}/api/tasks/${task.id}/output`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` }
  }).then(r => r.json());
  console.log(resp.output);
  if (resp.status !== 'running') clearInterval(this);
}, 3000);
```

### Pattern 2: Live WebSocket watching

```javascript
const ws = new WebSocket(`ws://TANK_HOST:7878/ws?token=${TOKEN}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'listen_task', taskId: task.id }));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  process.stdout.write(msg.output);  // Live Claude Code output
};
```

### Pattern 3: Interactive — send follow-up instructions

```javascript
// Mid-task, after seeing the output, send more instructions
await fetch(`${TANK}/api/tasks/${task.id}/input`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ text: 'Also add rate limiting middleware.' })
});
```

### Pattern 4: Multi-task parallel

```javascript
const prom = 'Add documentation comments to all Python files. Use Google-style docstrings.';
const prompts = [
  { title: 'Auth module docs', prompt: `${prom} Focus on the auth/ directory.`, model: 'sonnet' },
  { title: 'API module docs', prompt: `${prom} Focus on the api/ directory.`, model: 'sonnet' },
  { title: 'Utils module docs', prompt: `${prom} Focus on the utils/ directory.`, model: 'haiku' },
];

const tasks = await Promise.all(prompts.map(p => 
  fetch(`${TANK}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...p, project_id: proj.id, repo_path: '/opt/my-project' })
  }).then(r => r.json())
));

// All three Claude Code instances run in parallel in separate tmux sessions
```

### Pattern 5: Flatten repo for context

```javascript
// Download all source files as a single flat text file
const flat = await fetch(`${TANK}/api/flatten/${proj.id}`, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
}).then(r => r.text());

// Feed this to your own context before designing prompts
console.log(`Repo context: ${flat.length} bytes`);
```

## Critical Gotchas

### Root permissions required for tmux
Tank's tmux sessions run as whichever user starts the Tank server. If that's root, you need Claude Code 2.1.175 with `--dangerously-skip-permissions`. If it's a non-root user, newer Claude Code versions work fine — but this skill assumes root because Tank is designed for VPS administration.

### Claude Code authentication
Claude Code in tmux uses the auth token from the system user running Tank. Make sure `claude` is authenticated:
```bash
claude --version  # should print version, not "not found"
```

### tmux sessions pile up
If you don't mark tasks as complete, tmux sessions keep running. Check with:
```bash
tmux list-sessions
# Kill orphans manually if needed:
tmux kill-session -t tank-abc12345
```

### Port binding
Tank binds to `127.0.0.1:7878` by default. It does NOT expose to the internet — you need a reverse proxy or tunnel for external access.

### Token security
- Never commit the token. Add `.env` to `.gitignore`.
- Use `openssl rand -hex 32` to generate.
- Pass it as a Bearer header or cookie, not in URL query strings.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Server won't start | `TANK_TOKEN` not set | `export TANK_TOKEN=...` |
| "claude: command not found" in tmux | Claude Code not installed or wrong PATH | `npm install -g @anthropic-ai/claude-code@2.1.175` |
| Claude Code exits immediately in tmux | Wrong version blocking `--dangerously-skip-permissions` | Pin to 2.1.175 |
| WebSocket 401 | Token mismatch | Check token in query string: `?token=...` |
| "No repo path" on flatten | Project was created without `repo_path` | Recreate project with `repo_path` set |
| Tasks stay "running" forever | tmux session died | Check `tmux list-sessions`, manually mark complete |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TANK_TOKEN` | Yes | — | Secret token for API/WS auth |
| `PORT` | No | `7878` | Server port |
