import { ChildProcess, spawn } from "child_process";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { log } from "../utils/index.js";

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_POLL_MS = 50;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 500;

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to read port")));
      }
    });
  });
}

export interface TunnelConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshKey?: string;
  remoteHost: string;
  remotePort: number;
}

export interface WaitForTcpOptions {
  timeoutMs: number;
  intervalMs: number;
}

export async function waitForTcpReady(
  port: number,
  opts: WaitForTcpOptions,
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const ok = await tryConnect(port);
    if (ok) return;
    await sleep(opts.intervalMs);
  }
  throw new Error(`TCP readiness timeout: 127.0.0.1:${port} did not accept within ${opts.timeoutMs}ms`);
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildSshArgv(cfg: TunnelConfig, localPort: number): string[] {
  const argv: string[] = [
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-L", `${localPort}:${cfg.remoteHost}:${cfg.remotePort}`,
  ];
  if (cfg.sshUser) argv.push("-l", cfg.sshUser);
  if (cfg.sshPort !== undefined) argv.push("-p", String(cfg.sshPort));
  if (cfg.sshKey) argv.push("-i", expandHome(cfg.sshKey));
  argv.push(cfg.sshHost);
  return argv;
}

export interface TunnelOptions {
  spawnPath?: string;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  shutdownGraceMs?: number;
  onRuntimeExit?: (code: number | null, stderrTail: string) => void;
}

export interface ActiveTunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function startTunnel(
  cfg: TunnelConfig,
  opts: TunnelOptions = {},
): Promise<ActiveTunnel> {
  const spawnPath = opts.spawnPath ?? "ssh";
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const pollMs = opts.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_MS;

  if (cfg.sshKey) {
    const expanded = expandHome(cfg.sshKey);
    if (!fs.existsSync(expanded)) {
      throw new Error(`SSH key not found: ${cfg.sshKey}`);
    }
  }

  const localPort = await pickFreePort();
  const argv = buildSshArgv(cfg, localPort);

  const child = spawn(spawnPath, argv, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrBuf: string[] = [];
  let stderrBytes = 0;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      log("info", `[ssh] ${line}`);
    }
    stderrBuf.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > STDERR_TAIL_BYTES && stderrBuf.length > 1) {
      stderrBytes -= stderrBuf.shift()!.length;
    }
  });

  const stderrTail = () => {
    const joined = stderrBuf.join("");
    return joined.slice(Math.max(0, joined.length - STDERR_TAIL_BYTES));
  };

  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code) => {
      setImmediate(() => {
        reject(new Error(`SSH tunnel failed (exit ${code}): ${stderrTail()}`));
      });
    });
    child.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`SSH tunnel: '${spawnPath}' command not found on PATH. Install OpenSSH client.`));
      } else {
        reject(err);
      }
    });
  });

  try {
    await Promise.race([
      waitForTcpReady(localPort, { timeoutMs: readinessTimeoutMs, intervalMs: pollMs }),
      earlyExit,
    ]);
  } catch (err) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    throw err;
  }

  return makeActiveTunnel(child, localPort, opts, stderrTail);
}

function makeActiveTunnel(
  child: ChildProcess,
  localPort: number,
  opts: TunnelOptions,
  stderrTail: () => string,
): ActiveTunnel {
  let closing = false;
  const onRuntimeExit = opts.onRuntimeExit ?? defaultRuntimeExit;

  const runtimeExitListener = (code: number | null) => {
    if (closing) return;
    log("error", `[ssh] tunnel exited unexpectedly (code ${code}). stderr tail: ${stderrTail()}`);
    onRuntimeExit(code, stderrTail());
  };
  child.on("exit", runtimeExitListener);

  const close = async () => {
    if (closing) return;
    closing = true;
    child.removeListener("exit", runtimeExitListener);
    if (child.exitCode !== null || child.killed) return;

    const grace = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    child.kill("SIGTERM");
    const exited = await waitForExit(child, grace);
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(child, grace);
    }
  };

  return { localPort, close };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function defaultRuntimeExit(_code: number | null, _stderrTail: string): Promise<void> {
  const { safeExit } = await import("../db/index.js");
  safeExit(1);
}
