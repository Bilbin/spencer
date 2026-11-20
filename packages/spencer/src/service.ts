/**
 * `spencer service install|uninstall|status`: optionally run Spencer in the background at login, for people
 * who want it always on without writing a unit file. Running `spencer` in a terminal never needs this.
 *
 * Linux: a systemd *user* unit (~/.config/systemd/user/spencer.service). macOS: a launchd agent
 * (~/Library/LaunchAgents/com.spencer.agent.plist). Files we did not write are never overwritten or removed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isBinary } from "./sea.ts";

const MARK = "managed by `spencer service install`";

/** The command that starts this same Spencer: the binary itself, or node + this script. */
function selfCommand(): string[] {
  if (isBinary()) return [process.execPath];
  const script = process.argv[1];
  if (!script) throw new Error("cannot tell which script is running");
  return [process.execPath, ...process.execArgv, script];
}

function systemdUnit(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", "spencer.service");
}
function launchdPlist(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.spencer.agent.plist");
}

function ours(file: string): boolean {
  return readFileSync(file, "utf8").includes(MARK);
}

/** systemd quoting for ExecStart: each argument double-quoted, with \ " and % escaped. */
function sdQuote(a: string): string {
  return `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function run(cmd: string, args: string[], quiet = false): boolean {
  try {
    execFileSync(cmd, args, { stdio: quiet ? "ignore" : "inherit" });
    return true;
  } catch {
    return false;
  }
}

export function serviceCommand(action: string | undefined, dataDir: string, out: (s: string) => void): number {
  const argv = [...selfCommand(), "--no-open", "--data-dir", dataDir];
  if (process.platform === "linux") {
    const file = systemdUnit();
    if (action === "install") {
      if (existsSync(file) && !ours(file)) {
        out(`${file} exists and was not written by spencer; not touching it.\n`);
        return 1;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `# ${MARK}
[Unit]
Description=Spencer agent
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${argv.map(sdQuote).join(" ")}
# Model API keys, e.g. ANTHROPIC_API_KEY=… (one per line, mode 0600)
EnvironmentFile=-${join(dataDir, "secrets", "model.env").replace(/%/g, "%%")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
      );
      const ok = run("systemctl", ["--user", "daemon-reload"]) && run("systemctl", ["--user", "enable", "--now", "spencer.service"]);
      out(
        ok
          ? `Installed and started ${file}.\nIt starts when you log in; to keep it running while logged out: loginctl enable-linger $USER\nLogs: journalctl --user -u spencer -f\n`
          : `Wrote ${file}, but systemctl failed; start it with: systemctl --user enable --now spencer\n`,
      );
      return ok ? 0 : 1;
    }
    if (action === "uninstall") {
      if (!existsSync(file)) return out("Not installed.\n"), 0;
      if (!ours(file)) return out(`${file} was not written by spencer; not touching it.\n`), 1;
      run("systemctl", ["--user", "disable", "--now", "spencer.service"]);
      rmSync(file);
      run("systemctl", ["--user", "daemon-reload"]);
      out("Stopped and removed the service. Your data is untouched.\n");
      return 0;
    }
    if (action === "status") {
      if (!existsSync(file)) return out("Not installed. Run: spencer service install\n"), 0;
      run("systemctl", ["--user", "--no-pager", "status", "spencer.service"]);
      return 0;
    }
  } else if (process.platform === "darwin") {
    const file = launchdPlist();
    const uid = String(process.getuid?.() ?? "");
    if (action === "install") {
      if (existsSync(file) && !ours(file)) return out(`${file} exists and was not written by spencer; not touching it.\n`), 1;
      mkdirSync(dirname(file), { recursive: true });
      mkdirSync(join(dataDir, "logs"), { recursive: true });
      writeFileSync(
        file,
        `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARK} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spencer.agent</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(join(dataDir, "logs", "spencer.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dataDir, "logs", "spencer.log"))}</string>
</dict>
</plist>
`,
      );
      run("launchctl", ["bootout", `gui/${uid}/com.spencer.agent`], true);
      const ok = run("launchctl", ["bootstrap", `gui/${uid}`, file]);
      out(ok ? `Installed and started ${file}. Logs: ${join(dataDir, "logs", "spencer.log")}\n` : `Wrote ${file}, but launchctl failed.\n`);
      return ok ? 0 : 1;
    }
    if (action === "uninstall") {
      if (!existsSync(file)) return out("Not installed.\n"), 0;
      if (!ours(file)) return out(`${file} was not written by spencer; not touching it.\n`), 1;
      run("launchctl", ["bootout", `gui/${uid}/com.spencer.agent`], true);
      rmSync(file);
      out("Stopped and removed the service. Your data is untouched.\n");
      return 0;
    }
    if (action === "status") {
      if (!existsSync(file)) return out("Not installed. Run: spencer service install\n"), 0;
      run("launchctl", ["print", `gui/${uid}/com.spencer.agent`]);
      return 0;
    }
  } else {
    out("spencer service is supported on Linux (systemd) and macOS (launchd). Elsewhere, just run spencer.\n");
    return 1;
  }
  out("usage: spencer service install|uninstall|status\n");
  return 2;
}
