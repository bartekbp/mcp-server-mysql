import { describe, it, expect } from "vitest";
import * as mysql from "mysql2/promise";
import { startTunnel } from "../../src/ssh/tunnel.js";

const gated = process.env.SSH_TUNNEL_INTEGRATION === "true"
  ? describe
  : describe.skip;

gated("SSH tunnel integration (real ssh to localhost)", () => {
  it("forwards a real MySQL query through an ssh -L tunnel", async () => {
    const tunnel = await startTunnel({
      sshHost: "localhost",
      remoteHost: process.env.MYSQL_HOST || "127.0.0.1",
      remotePort: Number(process.env.MYSQL_PORT || "3306"),
    });

    try {
      const conn = await mysql.createConnection({
        host: "127.0.0.1",
        port: tunnel.localPort,
        user: process.env.MYSQL_USER || "mcp_test",
        password: process.env.MYSQL_PASS || "mcp_test_password",
        database: process.env.MYSQL_DB || "mcp_test",
      });
      try {
        const [rows] = await conn.query("SELECT 1 AS one");
        expect(rows).toEqual([{ one: 1 }]);
      } finally {
        await conn.end();
      }
    } finally {
      await tunnel.close();
    }
  });
});
