import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSshTunnelConfig } from "../../src/config/index.js";

const VARS = [
  "SSH_HOST", "SSH_USER", "SSH_PORT", "SSH_KEY",
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_SOCKET_PATH",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getSshTunnelConfig", () => {
  it("returns undefined when SSH_HOST is absent", () => {
    expect(getSshTunnelConfig()).toBeUndefined();
  });

  it("returns config with defaults when only SSH_HOST is set", () => {
    process.env.SSH_HOST = "bastion.example.com";
    process.env.MYSQL_HOST = "db.internal";
    process.env.MYSQL_PORT = "3306";
    expect(getSshTunnelConfig()).toEqual({
      sshHost: "bastion.example.com",
      remoteHost: "db.internal",
      remotePort: 3306,
    });
  });

  it("carries optional SSH_USER/SSH_PORT/SSH_KEY through", () => {
    process.env.SSH_HOST = "bastion";
    process.env.SSH_USER = "ec2-user";
    process.env.SSH_PORT = "2222";
    process.env.SSH_KEY = "~/.ssh/mykey.pem";
    process.env.MYSQL_HOST = "db";
    process.env.MYSQL_PORT = "3306";
    expect(getSshTunnelConfig()).toEqual({
      sshHost: "bastion",
      sshUser: "ec2-user",
      sshPort: 2222,
      sshKey: "~/.ssh/mykey.pem",
      remoteHost: "db",
      remotePort: 3306,
    });
  });

  it("returns undefined when MYSQL_SOCKET_PATH is also set (socket wins)", () => {
    process.env.SSH_HOST = "bastion";
    process.env.MYSQL_SOCKET_PATH = "/tmp/mysql.sock";
    expect(getSshTunnelConfig()).toBeUndefined();
  });

  it("throws on non-numeric SSH_PORT", () => {
    process.env.SSH_HOST = "bastion";
    process.env.SSH_PORT = "not-a-number";
    expect(() => getSshTunnelConfig()).toThrow(/SSH_PORT/);
  });
});
