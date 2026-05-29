module.exports = {
  apps: [{
    name: 'tank',
    script: 'server/index.js',
    cwd: '/opt/tank',
    env: { NODE_ENV: 'production', PORT: '7878' },
    max_memory_restart: '500M',
    restart_delay: 3000,
    max_restarts: 10,
  }]
}
