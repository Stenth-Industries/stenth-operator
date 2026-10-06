/**
 * Spawning and reliably killing a TypeScript child process.
 *
 * Two of the Day 2 gates need real processes: a worker that dies mid-job, and
 * two schedulers racing for the advisory lock. Both depend on the kill actually
 * killing the thing holding the database session.
 *
 * node_modules/.bin/tsx is a shim that forks a second Node process, so
 * SIGKILLing the shim leaves the grandchild — and its Postgres session, and its
 * advisory lock — alive. That cost an afternoon of "the lock was never
 * released". Spawning node with --import tsx makes the direct child the process
 * that holds the connection, and detaching it into its own process group means
 * a group kill reaches everything it started.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

export function spawnScript(
  relativePath: string,
  env: Record<string, string | undefined>,
): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', join(repoRoot, relativePath)], {
    cwd: repoRoot,
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

/** Kills the child and everything it spawned, and waits for it to be gone. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once('exit', () => resolve());

    try {
      if (child.pid !== undefined) {
        // Negative pid: the whole process group, which detached: true created.
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // Already gone, or never started.
      try {
        child.kill('SIGKILL');
      } catch {
        resolve();
      }
    }
  });
}

/** Resolves with the child's first line of stdout, parsed as JSON. */
export function firstJsonLine<T>(child: ChildProcess, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      void killTree(child);
      reject(new Error(`child produced no output in time: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout.slice(0, newline)) as T);
        } catch (error) {
          reject(new Error(`child produced unparseable output "${stdout}": ${String(error)}`));
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (stdout.includes('\n')) {
        return;
      }
      clearTimeout(timer);
      reject(new Error(`child exited ${String(code)} without output: ${stderr}`));
    });
  });
}

/** Runs a script to completion and resolves with its JSON stdout. */
export function runScript<T>(
  relativePath: string,
  env: Record<string, string | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const child = spawnScript(relativePath, env);
  return firstJsonLine<T>(child, timeoutMs).finally(() => killTree(child));
}
