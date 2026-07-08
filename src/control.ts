import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { listSessions, endSession, endAll, killSession, pruneEnded, type SessionServiceHost } from "./sessions.js";

export const CONTROL_SOCKET = join(CONFIG_DIR, "control.sock");

export async function handleControlCommand(
  host: SessionServiceHost,
  cmd: string,
  args?: { num?: number },
): Promise<unknown> {
  switch (cmd) {
    case "list":
      return listSessions(host);
    case "end":
      return endSession(host, Number(args?.num));
    case "endAll":
      return endAll(host);
    case "kill":
      return killSession(host, Number(args?.num));
    case "prune":
      return pruneEnded(host);
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

export function startControlServer(host: SessionServiceHost): Server {
  if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET);
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      void (async () => {
        try {
          const { cmd, args } = JSON.parse(line) as { cmd: string; args?: { num?: number } };
          const data = await handleControlCommand(host, cmd, args);
          sock.end(JSON.stringify({ ok: true, data }) + "\n");
        } catch (err) {
          sock.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        }
      })();
    });
    sock.on("error", () => sock.destroy());
  });
  server.listen(CONTROL_SOCKET, () => chmodSync(CONTROL_SOCKET, 0o600));
  return server;
}
