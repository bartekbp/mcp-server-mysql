import { ChildProcess } from "child_process";
import * as net from "net";
import * as os from "os";
import * as path from "path";

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
  _cfg: TunnelConfig,
  _opts: TunnelOptions = {},
): Promise<ActiveTunnel> {
  throw new Error("startTunnel not yet implemented");
}
