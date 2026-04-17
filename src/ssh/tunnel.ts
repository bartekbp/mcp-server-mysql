import { ChildProcess } from "child_process";

export interface TunnelConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshKey?: string;
  remoteHost: string;
  remotePort: number;
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
