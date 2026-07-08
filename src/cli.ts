#!/usr/bin/env bun
/**
 * claudecord CLI — manage the bot as a macOS launchd daemon.
 *
 *   claudecord install     write the LaunchAgent (embeds DISCORD_TOKEN) and start it
 *   claudecord uninstall   stop and remove the LaunchAgent
 *   claudecord start       start (or restart) the daemon
 *   claudecord stop        stop the daemon
 *   claudecord restart     restart the daemon
 *   claudecord status      daemon state, pid, sessions, recent log
 *   claudecord logs        tail the logs (-f)
 *   claudecord run         run in the foreground (no daemon)
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.christianfurr.claudecord";
const REPO = dirname(dirname(fileURLToPath(import.meta.url))); // src/.. = repo root
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), ".claudecord", "logs");
const OUT_LOG = join(LOG_DIR, "claudecord.log");
const ERR_LOG = join(LOG_DIR, "claudecord.err.log");
const UID = process.getuid?.() ?? 501;
const DOMAIN = `gui/${UID}`;

function sh(cmd: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  if (!opts.quiet && res.status !== 0) console.error(out.trim());
  return { ok: res.status === 0, out };
}

function resolveToken(): string {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  console.error("DISCORD_TOKEN not found. Put it in .env in the repo (or export it) and rerun.");
  process.exit(1);
}

function buildPlist(token: string): string {
  const bun = process.execPath; // the bun binary running this script
  const path = [
    dirname(bun),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <!-- Launch via Apple-signed sh so macOS attributes the login item to this
         plist's label instead of the Bun binary's code signer. -->
    <string>/bin/sh</string>
    <string>-c</string>
    <string>exec '${escape(bun)}' '${escape(join(REPO, "src", "index.ts"))}'</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DISCORD_TOKEN</key><string>${escape(token)}</string>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(OUT_LOG)}</string>
  <key>StandardErrorPath</key><string>${escape(ERR_LOG)}</string>
</dict>
</plist>
`;
}

function isLoaded(): boolean {
  return sh(["launchctl", "print", `${DOMAIN}/${LABEL}`], { quiet: true }).ok;
}

function daemonPid(): string | undefined {
  const { ok, out } = sh(["launchctl", "print", `${DOMAIN}/${LABEL}`], { quiet: true });
  if (!ok) return undefined;
  return out.match(/pid = (\d+)/)?.[1];
}

function install(): void {
  const token = resolveToken();
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  if (isLoaded()) {
    sh(["launchctl", "bootout", `${DOMAIN}/${LABEL}`], { quiet: true });
    // launchd releases the label asynchronously — bootstrapping too soon EIOs.
    const deadline = Date.now() + 10_000;
    while (isLoaded() && Date.now() < deadline) spawnSync("sleep", ["0.5"]);
  }
  writeFileSync(PLIST, buildPlist(token));
  chmodSync(PLIST, 0o600); // the plist embeds the token — owner-only
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    if (attempt > 0) spawnSync("sleep", ["2"]);
    ok = sh(["launchctl", "bootstrap", DOMAIN, PLIST], { quiet: attempt < 3 }).ok;
  }
  if (!ok) process.exit(1);
  console.log(`installed and started ${LABEL}`);
  console.log(`logs: ${OUT_LOG}`);
}

function uninstall(): void {
  if (isLoaded()) sh(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log("daemon removed (repo and config untouched)");
}

function start(): void {
  if (!existsSync(PLIST)) {
    console.error("not installed — run: claudecord install");
    process.exit(1);
  }
  if (!isLoaded()) sh(["launchctl", "bootstrap", DOMAIN, PLIST]);
  sh(["launchctl", "kickstart", `${DOMAIN}/${LABEL}`]);
  console.log("started");
}

function stop(): void {
  if (isLoaded()) sh(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]);
  console.log("stopped");
}

function restart(): void {
  if (!isLoaded()) return start();
  sh(["launchctl", "kickstart", "-k", `${DOMAIN}/${LABEL}`]);
  console.log("restarted");
}

function status(): void {
  const pid = daemonPid();
  console.log(pid ? `● running (pid ${pid})` : isLoaded() ? "◐ loaded but not running" : "○ not installed/loaded");

  const registryFile = join(homedir(), ".claudecord", "sessions.json");
  if (existsSync(registryFile)) {
    const reg = JSON.parse(readFileSync(registryFile, "utf8")) as {
      sessions: Record<string, { sessionNum: number; title: string; status: string }>;
    };
    const sessions = Object.values(reg.sessions);
    const active = sessions.filter((s) => s.status === "active").length;
    console.log(`sessions: ${active} active / ${sessions.length} total`);
  }

  if (existsSync(OUT_LOG)) {
    const lines = readFileSync(OUT_LOG, "utf8").trimEnd().split("\n").slice(-5);
    console.log("\nrecent log:");
    for (const line of lines) console.log(`  ${line}`);
  }
}

function logs(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  spawnSync("tail", ["-n", "50", "-f", OUT_LOG, ERR_LOG], { stdio: "inherit" });
}

const command = process.argv[2];
switch (command) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  case "run":
    await import("./index.js");
    break;
  default:
    console.log(
      "claudecord <install|uninstall|start|stop|restart|status|logs|run>",
    );
    process.exit(command ? 1 : 0);
}
