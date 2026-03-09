import { execSync } from 'node:child_process';
import process from 'node:process';

const port = Number(process.argv[2] || 5000);
const force = process.argv.includes('--force');

function run(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function getListeningPidsWin(targetPort) {
  const out = run('netstat -ano -p tcp');
  const lines = out.split(/\r?\n/);
  const pids = new Set();
  for (const line of lines) {
    if (!line.includes(`:${targetPort}`)) continue;
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function getListeningPidsUnix(targetPort) {
  try {
    const out = run(`lsof -ti tcp:${targetPort} -sTCP:LISTEN`);
    return out
      .split(/\r?\n/)
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
  } catch {
    return [];
  }
}

function getProcessCommandWin(pid) {
  try {
    const cmd = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`;
    return run(`powershell -NoProfile -Command "${cmd}"`).trim();
  } catch {
    return '';
  }
}

function getProcessCommandUnix(pid) {
  try {
    return run(`ps -p ${pid} -o command=`).trim();
  } catch {
    return '';
  }
}

function killPidWin(pid) {
  run(`taskkill /PID ${pid} /F`);
}

function killPidUnix(pid) {
  run(`kill -9 ${pid}`);
}

const isWin = process.platform === 'win32';
const cwd = process.cwd().toLowerCase();
const pids = isWin ? getListeningPidsWin(port) : getListeningPidsUnix(port);

if (pids.length === 0) {
  console.log(`Port ${port} is already free.`);
  process.exit(0);
}

console.log(`Port ${port} is in use by PID(s): ${pids.join(', ')}`);

for (const pid of pids) {
  const commandLine = isWin ? getProcessCommandWin(pid) : getProcessCommandUnix(pid);
  const cmdLower = commandLine.toLowerCase();
  const looksLikeThisRepo =
    cmdLower.includes(cwd) ||
    cmdLower.includes('server/server.ts') ||
    cmdLower.includes('tsx') ||
    cmdLower.includes('vite');

  if (!force && !looksLikeThisRepo) {
    console.error(`Refusing to kill PID ${pid} because it does not look like this repo process.`);
    console.error(`Use --force if you want to kill it anyway. Command: ${commandLine || '(unknown)'}`);
    process.exit(1);
  }

  try {
    if (isWin) killPidWin(pid);
    else killPidUnix(pid);
    console.log(`Killed PID ${pid}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to kill PID ${pid}: ${msg}`);
    process.exit(1);
  }
}

console.log(`Port ${port} was released successfully.`);
