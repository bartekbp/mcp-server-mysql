import { getSshTunnelConfig, mcpConfig } from "../config/index.js";
import { startTunnel, ActiveTunnel, TunnelOptions } from "./tunnel.js";
import { log } from "../utils/index.js";

export async function setupSshTunnelIfConfigured(
  opts?: TunnelOptions,
): Promise<ActiveTunnel | undefined> {
  const sshCfg = getSshTunnelConfig();
  if (!sshCfg) return undefined;

  log(
    "info",
    `Starting SSH tunnel via ${sshCfg.sshHost} -> ${sshCfg.remoteHost}:${sshCfg.remotePort}...`,
  );
  const tunnel = await startTunnel(sshCfg, opts);
  log("info", `SSH tunnel ready on 127.0.0.1:${tunnel.localPort}`);
  (mcpConfig.mysql as { host?: string; port?: number }).host = "127.0.0.1";
  (mcpConfig.mysql as { host?: string; port?: number }).port = tunnel.localPort;
  return tunnel;
}
