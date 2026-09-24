import { execSync } from 'node:child_process';

const port = Number(process.argv[2]);

if (!Number.isFinite(port)) {
  process.exit(0);
}

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return '';
  }
}

if (process.platform === 'win32') {
  const output = run(`netstat -ano | findstr :${port}`);
  const pids = new Set();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }

  for (const pid of pids) {
    run(`taskkill /PID ${pid} /F`);
  }

  process.exit(0);
}

if (process.platform === 'darwin') {
  const pids = run(`lsof -t -i:${port}`)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const pid of pids) {
    run(`kill -9 ${pid}`);
  }
  process.exit(0);
}

const pids = run(`lsof -t -i:${port}`)
  .split(/\r?\n/)
  .map(s => s.trim())
  .filter(Boolean);
for (const pid of pids) {
  run(`kill -9 ${pid}`);
}

