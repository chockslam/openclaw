import { createReadTool, createWriteTool, createEditTool } from "@mariozechner/pi-coding-agent";
import chalk from "chalk";
import * as crypto from "node:crypto";
import * as os from "node:os";
import WebSocket from "ws";
import { createExecTool } from "../agents/bash-tools.js";

interface SatelliteConfig {
  nodeId: string;
  gatewayUrl: string;
  displayName: string;
  privateKey?: string; // Private key for signing challenges
  token?: string; // Future: auth token
}

interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  params: any;
}

export async function runSatelliteServer(config: SatelliteConfig) {
  console.log(chalk.cyan(`🛰️  Starting Satellite Node: ${config.displayName}`));
  console.log(chalk.dim(`   Node ID: ${config.nodeId}`));
  console.log(chalk.dim(`   Gateway: ${config.gatewayUrl}`));

  // TLS Enforcement: Warn if connecting over unencrypted HTTP
  if (config.gatewayUrl.startsWith("http://")) {
    console.log();
    console.log(chalk.yellow("⚠️  WARNING: Connecting over unencrypted HTTP!"));
    console.log(
      chalk.yellow("   Private keys and tool call data will be transmitted in plaintext."),
    );
    console.log(chalk.yellow("   Use https:// in production environments."));
    console.log();
  }

  // Initialize Tools
  // We run with full access to the machine since this is a personal satellite node
  const tools = new Map<string, any>();

  const readTool = createReadTool(process.cwd());
  const writeTool = createWriteTool(process.cwd());
  const editTool = createEditTool(process.cwd());
  const execTool = createExecTool({
    cwd: process.cwd(),
  });

  tools.set("read_file", readTool);
  tools.set("write_file", writeTool);
  tools.set("edit_file", editTool);
  tools.set("run_terminal_command", execTool);

  // Reconnect logic
  let ws: WebSocket | null = null;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let isShuttingDown = false;

  const connect = () => {
    if (isShuttingDown) return;

    const url = config.gatewayUrl.replace(/^http/, "ws") + "/ws/satellite";
    console.log(chalk.dim(`Connecting to ${url}...`));

    ws = new WebSocket(url, {
      headers: {
        "x-satellite-node-id": config.nodeId,
        // "Authorization": `Bearer ${config.token}` // Future
      },
    });

    ws.on("open", () => {
      console.log(chalk.green("✅ Connected to Gateway"));

      // Authenticate node
      if (ws) {
        ws.send(
          JSON.stringify({
            type: "auth",
            nodeId: config.nodeId,
          }),
        );
      }
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(msg);
      } catch (err) {
        console.error(chalk.red("Failed to parse message:"), err);
      }
    });

    ws.on("error", (err) => {
      console.error(chalk.red("WebSocket error:"), err.message);
    });

    ws.on("close", () => {
      console.log(chalk.yellow("Disconnected from Gateway"));
      ws = null;
      if (!isShuttingDown) {
        console.log(chalk.dim("Reconnecting in 5s..."));
        reconnectTimeout = setTimeout(connect, 5000);
      }
    });
  };

  const handleMessage = async (msg: any) => {
    if (msg.type === "auth_challenge") {
      console.log(chalk.dim("🔐 Received auth challenge, signing..."));

      if (!config.privateKey) {
        console.error(chalk.red("Error: No private key found for authentication."));
        return;
      }

      try {
        // Sign the challenge nonce
        const signature = crypto.sign(
          undefined,
          Buffer.from(msg.nonce, "base64"),
          config.privateKey,
        );

        // Send back verification
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "auth_verify",
              signature: signature.toString("base64"),
            }),
          );
        }
      } catch (err) {
        console.error(chalk.red("Failed to sign challenge:"), err);
      }
      return;
    }

    if (msg.type === "auth_success") {
      console.log(chalk.green("✨ Identity verified and authenticated"));
      return;
    }

    if (msg.type === "tool_call") {
      const payload = msg.payload as ToolCallPayload;
      console.log(chalk.blue(`🛠️  Executing tool: ${payload.toolName}`));

      const tool = tools.get(payload.toolName);
      if (!tool) {
        sendError(payload.toolCallId, `Tool not found: ${payload.toolName}`);
        return;
      }

      try {
        // Execute tool
        // Note: pi-coding-agent tools might have different signatures
        // But generally execute(toolCallId, params)
        const result = await tool.execute(payload.toolCallId, payload.params);

        sendSuccess(payload.toolCallId, result);
      } catch (err) {
        console.error(chalk.red(`Error executing ${payload.toolName}:`), err);
        sendError(payload.toolCallId, err instanceof Error ? err.message : String(err));
      }
    } else if (msg.type === "heartbeat_ack") {
      // Heartbeat acknowledged
    }
  };

  const sendSuccess = (toolCallId: string, result: any) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "tool_result",
          payload: {
            toolCallId,
            status: "success",
            result,
          },
        }),
      );
    }
  };

  const sendError = (toolCallId: string, error: string) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "tool_result",
          payload: {
            toolCallId,
            status: "error",
            error,
          },
        }),
      );
    }
  };

  // Start connection
  connect();

  // Handle shutdown
  const cleanup = () => {
    isShuttingDown = true;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (ws) ws.close();
    console.log(chalk.cyan("\nStopped Satellite Node"));
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive
  await new Promise(() => {});
}
