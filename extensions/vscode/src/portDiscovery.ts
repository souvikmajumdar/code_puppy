import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * Resolves the directory where code-puppy stores runtime state files,
 * mirroring the logic in code_puppy/config.py :: _get_xdg_dir().
 *
 * Rules (in order):
 *  1. If $XDG_STATE_HOME is set  →  $XDG_STATE_HOME/code_puppy
 *  2. Otherwise                  →  ~/.code_puppy   (legacy fallback)
 *
 * Note: code-puppy deliberately does NOT use ~/.local/state/code_puppy
 * as an automatic default — it only uses XDG paths when the env var is
 * explicitly set by the user.  We must match that behaviour exactly or
 * we will look in the wrong directory and never find the port file.
 */
function resolveStateDir(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  if (xdgStateHome) {
    return path.join(xdgStateHome, "code_puppy");
  }
  return path.join(os.homedir(), ".code_puppy");
}

/**
 * The port file written by cli_runner.py after code-puppy starts.
 *
 * Written at:  {STATE_DIR}/api_server.port
 * Removed at:  server shutdown (app.py lifespan handler)
 *
 * Content:     a single integer, e.g. "8090\n"
 *
 * KNOWN BUG (G1 / G11 in 01-gaps-and-risks.md):
 *   cli_runner.py writes this file speculatively at REPL startup using
 *   find_available_port() (8090–9010 range).  The actual API server is
 *   started separately by `/api start`, which defaults to port 8765.
 *   The two ports can differ.  We work around this by verifying the port
 *   from the file is reachable and, if not, trying the known default.
 */
const PORT_FILE_NAME = "api_server.port";

/**
 * The hardcoded default port used by `start_api_server()` in
 * terminal_tools.py.  Used as a fallback when the port file points
 * to a port that isn't listening (the common case during Phase 1 dev).
 *
 * Remove this fallback once the upstream bug is fixed and the port file
 * is written after the server actually starts on its real port.
 */
const FALLBACK_PORT = 8765;

/** Result type so callers know *why* discovery failed. */
export type PortDiscoveryResult =
  | { ok: true; port: number; source: "port_file" | "fallback" }
  | { ok: false; reason: "not_running" | "bad_content" | "read_error"; detail: string };

/**
 * Synchronously checks whether a TCP port is open on 127.0.0.1.
 * Uses a raw net.Socket with a short timeout so the check is fast.
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => { socket.destroy(); resolve(false); };
    socket.setTimeout(500);
    socket.on("error", onError);
    socket.on("timeout", onError);
    socket.connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Discovers the port the code-puppy API server is listening on.
 *
 * Strategy:
 *  1. Read the port file written by cli_runner.py.
 *  2. Check whether that port actually has something listening.
 *  3. If yes  → return it (source: "port_file").
 *  4. If no   → try FALLBACK_PORT (8765, the `/api start` default).
 *  5. If that is listening → return it (source: "fallback").
 *  6. Otherwise → return an error describing what we tried.
 *
 * Returns a typed result rather than throwing so callers can show a
 * friendly message in the VS Code UI instead of an unhandled exception.
 *
 * NOTE: This function is async because the TCP probe is non-blocking.
 * Callers must await it.
 */
export async function discoverPort(): Promise<PortDiscoveryResult> {
  const portFilePath = path.join(resolveStateDir(), PORT_FILE_NAME);

  // Step 1: attempt to read the port file.
  let portFromFile: number | null = null;
  try {
    const raw = fs.readFileSync(portFilePath, "utf8");
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      portFromFile = parsed;
    }
  } catch {
    // File missing or unreadable — will rely on fallback below.
  }

  // Step 2: if we got a port from the file, check if it's actually listening.
  if (portFromFile !== null) {
    const listening = await isPortListening(portFromFile);
    if (listening) {
      return { ok: true, port: portFromFile, source: "port_file" };
    }
    // Port file exists but nothing is listening on that port.
    // This is the known bug: file was written before /api start was called,
    // or it points to 8090-range while the server started on 8765.
    // Fall through to try the fallback port.
  }

  // Step 3: try the known fallback port (8765 — the /api start default).
  const fallbackListening = await isPortListening(FALLBACK_PORT);
  if (fallbackListening) {
    return { ok: true, port: FALLBACK_PORT, source: "fallback" };
  }

  // Nothing is listening anywhere.
  if (portFromFile !== null) {
    return {
      ok: false,
      reason: "not_running",
      detail:
        `Port file at ${portFilePath} contained port ${portFromFile}, ` +
        `but nothing is listening there or on the fallback port ${FALLBACK_PORT}. ` +
        `Start code-puppy with \`pup -i\` then run \`/api start\` at the prompt.`,
    };
  }

  return {
    ok: false,
    reason: "not_running",
    detail:
      `Port file not found at ${portFilePath} and fallback port ${FALLBACK_PORT} ` +
      `is not listening. Start code-puppy with \`pup -i\` then run \`/api start\`.`,
  };
}
