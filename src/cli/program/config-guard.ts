import type { RuntimeEnv } from "../../runtime.js";
import { loadAndMaybeMigrateDoctorConfig } from "../../commands/doctor-config-flow.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
let didRunDoctorConfigFlow = false;
let didInitializeCliSessionBridge = false;
let sessionBridgeInitPromise: Promise<void> | null = null;
const SESSION_BRIDGE_REQUIRED_COMMANDS = new Set([
  "agent",
  "health",
  "message",
  "sandbox",
  "sessions",
  "status",
]);

function formatConfigIssues(issues: Array<{ path: string; message: string }>): string[] {
  return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}

function commandNeedsSessionBridge(commandPath?: string[]): boolean {
  const commandName = commandPath?.[0];
  if (!commandName) {
    return false;
  }
  return SESSION_BRIDGE_REQUIRED_COMMANDS.has(commandName);
}

async function ensureCliSessionBridgeReady(commandPath?: string[]): Promise<void> {
  if (!commandNeedsSessionBridge(commandPath)) {
    return;
  }
  if (didInitializeCliSessionBridge) {
    return;
  }
  if (!sessionBridgeInitPromise) {
    sessionBridgeInitPromise = (async () => {
      const [
        { createRuntimeStorageAdapter },
        { getSessionStoreBridge, initializeSessionStoreBridge },
      ] = await Promise.all([
        import("../../gateway/adapters/runtime-storage.js"),
        import("../../gateway/session-store-bridge.js"),
      ]);
      const storageAdapter = await createRuntimeStorageAdapter();
      initializeSessionStoreBridge(storageAdapter);
      await getSessionStoreBridge().warmStart();
      didInitializeCliSessionBridge = true;
    })();
  }
  try {
    await sessionBridgeInitPromise;
  } catch (err) {
    sessionBridgeInitPromise = null;
    throw err;
  }
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
}): Promise<void> {
  if (!didRunDoctorConfigFlow) {
    didRunDoctorConfigFlow = true;
    await loadAndMaybeMigrateDoctorConfig({
      options: { nonInteractive: true },
      confirm: async () => false,
    });
  }

  const snapshot = await readConfigFileSnapshot();
  const commandName = params.commandPath?.[0];
  const subcommandName = params.commandPath?.[1];
  const allowInvalid = commandName
    ? ALLOWED_INVALID_COMMANDS.has(commandName) ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0
      ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`)
      : [];

  const invalid = snapshot.exists && !snapshot.valid;
  const ensureSessionBridgeOrExit = async (errorFormatter: (value: string) => string) => {
    await ensureCliSessionBridgeReady(params.commandPath).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      params.runtime.error(errorFormatter(`Session storage bootstrap failed: ${message}`));
      params.runtime.exit(1);
    });
  };

  if (!invalid) {
    await ensureSessionBridgeOrExit((value) => value);
    return;
  }

  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
    return;
  }

  await ensureSessionBridgeOrExit(error);
}
