# Tank Mission Control

> tmux-based Claude Code orchestration bridge with real-time WebSocket UI.
> Built for AI agents. Controlled by AI agents. Not a human terminal multiplexer.

## What Tank Does

Tank lets an AI agent (like a Hermes agent) run Claude Code inside parallel tmux sessions on a VPS, then watch, steer, and stop those sessions through a web UI or API.

**One agent → Many Claude Code instances.** Each instance runs in its own tmux session. Each session belongs to a project. Each project has tasks. Each task gets a live WebSocket feed.

```
Hermes agent → Tank API → tmux → Claude Code
                        → WebSocket → Browser UI
```

## Architecture

| Layer | What |
|-------|------|
| **Projects** | Groups of related tasks (one per client repo) |
| **Tasks** | Individual Claude Code runs — each gets a tmux session |
| **tmux** | Persistent terminal multiplexer, perfect for long-running Claude Code |
| **WebSocket** | Real-time output streaming from running tasks |
| **REST API** | CRUD for projects and tasks, auth, repo flattening |
| **UI** | Single-page app: login, projects, tasks, live output feed |

## Who This Is For

**Tank is for AI agents.**

The human sets it up once. After that, their Hermes agent (or any agent that can make HTTP calls) owns it — creating projects, spawning tasks, watching output, sending follow-up prompts, closing sessions.

The web UI is for the human to peek in if they want. But the primary user is the agent.

> **Important:** When a Hermes agent clones this repo, it should not ask the human to operate Tank. The agent loads projects in, creates tasks, and uses Tank's API to run Claude Code autonomously. The human watches if they're curious.

## Prerequisites

| Requirement | Why |
|-------------|-----|
| **Node.js 20+** | Server runtime |
| **pnpm** | Package manager (workspace support) |
| **tmux** | Terminal multiplexer for Claude Code sessions |
| **Claude Code CLI** | Anthropic's `claude` CLI tool |
| **Claude Code Max subscription** | Required for API access |
| **Claude Code 2.1.175** | **Must pin to this version.** 2.1.176+ blocks `--dangerously-skip-permissions` as root |
| **Linux VPS (or macOS)** | Production target is Linux; macOS works for local dev |

### Pin Claude Code to 2.1.175

This is critical. Newer versions block the `--dangerously-skip-permissions` flag that Tank uses to run Claude Code in tmux as root:

```bash
npm install -g @anthropic-ai/claude-code@2.1.175
```

### Install tmux

```bash
# Ubuntu/Debian
apt install -y tmux

# macOS
brew install tmux
```

## Quick Start

```bash
# 1. Clone
git clone https://github.com/SimplyAi-Solustions/tank-mission-control.git
cd tank-mission-control

# 2. Install dependencies
pnpm install

# 3. Build the client
cd client && npx vite build && cd ..

# 4. Set your secret token
export TANK_TOKEN="your-64-char-random-string"

# 5. Start (localhost only by default)
node server/index.js
```

Tank is now running on `http://localhost:7878`. The agent connects here via API — the human can open it in a browser.

## GUI Exposure Options

By default, Tank listens on `127.0.0.1:7878` (localhost only). To make it accessible, pick one of these options:

### Option 1: Localhost (development)
```
No setup needed. Tank runs on localhost.
Good for: single-machine development, VPS where you SSH in.
```

### Option 2: Caddy Reverse Proxy (recommended for production)
```bash
# Install Caddy
apt install -y caddy

# Create Caddyfile
echo "tank.yourdomain.com {
    reverse_proxy 127.0.0.1:7878
}" > /etc/caddy/Caddyfile

systemctl restart caddy
```
**Good for:** permanent deployment with a real domain, automatic HTTPS.

### Option 3: Nginx Reverse Proxy
```nginx
server {
    listen 443 ssl;
    server_name tank.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:7878;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
**Good for:** servers already running Nginx.

### Option 4: SSH Tunnel
```bash
# From your local machine:
ssh -L 7878:127.0.0.1:7878 user@vps-ip
# Then open http://localhost:7878
```
**Good for:** quick access, no domain needed, no extra software.

### Option 5: Cloudflare Tunnel
```bash
# Install cloudflared, then:
cloudflared tunnel --url http://127.0.0.1:7878
```
**Good for:** temporary public URL without opening firewall ports.

### Option 6: Tailscale Funnel
```bash
tailscale funnel 7878
```
**Good for:** Tailscale users who want private mesh access.

> **Agent instruction:** When setting up Tank for a user, your Hermes agent should present these six options and let the user pick. Default to Option 1 (localhost) for development, Option 2 (Caddy) for production.

## API Reference

Tank exposes a REST API on the same port as the web UI. All protected endpoints require authentication.

### Authentication

Set a cookie by posting the token, or pass it as a Bearer header or `?token=` query parameter (for WebSocket connections).

```bash
# Set auth cookie
curl -X POST http://localhost:7878/api/login \
  -H "Content-Type: application/json" \
  -d '{"token":"your-token"}'

# Or use Bearer header on every request
curl http://localhost:7878/api/projects \
  -H "Authorization: Bearer your-token"
```

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/login` | No | Set auth cookie |
| `GET` | `/api/auth` | No | Check if authenticated |
| `GET` | `/api/projects` | Yes | List all projects |
| `POST` | `/api/projects` | Yes | Create project (`name`, `repo_path`, `icon`) |
| `GET` | `/api/tasks/:projectId` | Yes | List tasks for a project |
| `POST` | `/api/tasks` | Yes | Create task (`project_id`, `title`, `prompt`, `model`, `repo_path`) |
| `GET` | `/api/tasks/:taskId/output` | Yes | Get task output (last 50 lines of tmux pane) |
| `POST` | `/api/tasks/:taskId/input` | Yes | Send input to running task (`text`) |
| `POST` | `/api/tasks/:taskId/complete` | Yes | Mark task complete, kill tmux session |
| `GET` | `/api/flatten/:projectId` | Yes | Download all project source files as flat text |
| `WS` | `/ws` | Yes | WebSocket for real-time task output |

### WebSocket Protocol

```json
// Client → Server: subscribe to a task's output
{ "type": "listen_task", "taskId": "uuid-here" }

// Client → Server: send input to running task
{ "type": "task_input", "taskId": "uuid-here", "text": "continue\n" }

// Server → Client: real-time output stream
{ "type": "task_output", "taskId": "uuid-here", "output": "..." }
```

### Models

When creating a task, the `model` parameter maps to Claude Code's `--model` flag. Default is `opus`. Available models depend on your Claude Code subscription but typically include:

- `opus` — Claude Opus (default)
- `sonnet` — Claude Sonnet
- `haiku` — Claude Haiku

## How an Agent Uses Tank

Here's the typical workflow for a Hermes agent:

### 1. Create a project
```javascript
const project = await fetch('http://localhost:7878/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ name: 'client-website', repo_path: '/opt/client-website', icon: '🌐' })
}).then(r => r.json());
```

### 2. Flatten the repo (optional — to understand the codebase)
```javascript
const flat = await fetch(`http://localhost:7878/api/flatten/${project.id}`, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
}).then(r => r.text());
// Now feed 'flat' to Claude Code as context
```

### 3. Create a task
```javascript
const task = await fetch('http://localhost:7878/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({
    project_id: project.id,
    title: 'Add authentication pages',
    prompt: 'Create login and signup pages with form validation. Use Next.js API routes for the backend. Style with Tailwind.',
    model: 'sonnet',
    repo_path: '/opt/client-website'
  })
}).then(r => r.json());
// Tank spawns: tmux new-session -s tank-abc12345 → claude --dangerously-skip-permissions
// Then after 8 seconds, sends the prompt
```

### 4. Watch the output
```javascript
const ws = new WebSocket(`ws://localhost:7878/ws?token=${TOKEN}`);
ws.onopen = () => ws.send(JSON.stringify({ type: 'listen_task', taskId: task.id }));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg.output); // Live Claude Code output
};
```

### 5. Send follow-up input
```javascript
await fetch(`http://localhost:7878/api/tasks/${task.id}/input`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ text: 'Also add password reset flow' })
});
```

### 6. Complete the task
```javascript
await fetch(`http://localhost:7878/api/tasks/${task.id}/complete`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});
// Kills the tmux session, marks task as completed
```

## Security

- **No hardcoded tokens.** `TANK_TOKEN` must be set as an environment variable. The server refuses to start without it.
- **Always use HTTPS** in production. Options 2-6 above all support TLS.
- **Pick a strong token.** 64 random alphanumeric characters is good.
- **Don't expose Tank to the open internet without a reverse proxy.** Caddy or Nginx in front with HTTPS is the right pattern.
- **Auth covers everything.** API, WebSocket, and static files behind `/api/` all require authentication.

## Troubleshooting

### "TANK_TOKEN environment variable is required"
Set `TANK_TOKEN` before starting:
```bash
export TANK_TOKEN="your-secret-token"
node server/index.js
```
Or create a `.env` file and source it, or use PM2 with `env` in ecosystem.config.cjs.

### "claude: command not found" in tmux sessions
Claude Code is not installed or not in the tmux session's PATH.
```bash
which claude
npm install -g @anthropic-ai/claude-code@2.1.175
```

### Claude Code says "permission denied" in tmux
You're running a version newer than 2.1.175. Downgrade:
```bash
npm install -g @anthropic-ai/claude-code@2.1.175
```

### WebSocket connection fails
- Check the token is passed as a query parameter: `ws://host:7878/ws?token=YOUR_TOKEN`
- Check the reverse proxy passes WebSocket upgrade headers (Caddy does this automatically; Nginx needs explicit config)

## License

MIT — use it, fork it, build on it.
