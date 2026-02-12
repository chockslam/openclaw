/**
 * Satellite Node CLI
 *
 * Commands for pairing this machine as a Satellite Node to an Enterprise Gateway.
 *
 * Usage:
 *   openclaw satellite pair <gateway-url> [--name <name>]
 *   openclaw satellite status
 *   openclaw satellite disconnect
 */

import type { Command } from "commander";
import chalk from "chalk";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Config file location
const SATELLITE_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "satellite.json");

interface SatelliteConfig {
  nodeId: string;
  gatewayUrl: string;
  displayName: string;
  state: "pending" | "active" | "disconnected";
  pairedAt?: string;
  publicKey?: string;
  privateKey?: string;
}

function loadConfig(): SatelliteConfig | null {
  try {
    if (fs.existsSync(SATELLITE_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(SATELLITE_CONFIG_PATH, "utf8"));
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveConfig(config: SatelliteConfig): void {
  const dir = path.dirname(SATELLITE_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SATELLITE_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Ensure permissions are set even if file already existed
  try {
    fs.chmodSync(SATELLITE_CONFIG_PATH, 0o600);
  } catch {
    /* best-effort */
  }
}

function deleteConfig(): void {
  if (fs.existsSync(SATELLITE_CONFIG_PATH)) {
    fs.unlinkSync(SATELLITE_CONFIG_PATH);
  }
}

export function registerSatelliteCli(program: Command) {
  const satellite = program
    .command("satellite")
    .description("Manage this machine as a Satellite Node for Enterprise Gateway");

  // openclaw satellite pair <gateway-url>
  satellite
    .command("pair <gateway-url>")
    .description("Pair this machine with an Enterprise Gateway")
    .option("-n, --name <name>", "Display name for this node", os.hostname())
    .action(async (gatewayUrl: string, opts: { name: string }) => {
      console.log(chalk.cyan("🛰️  Initiating Satellite Node pairing..."));
      console.log(chalk.dim(`Gateway: ${gatewayUrl}`));
      console.log(chalk.dim(`Node name: ${opts.name}`));

      // TLS Enforcement: Warn if pairing over unencrypted HTTP
      if (gatewayUrl.startsWith("http://")) {
        console.log();
        console.log(chalk.yellow("⚠️  WARNING: Pairing over unencrypted HTTP!"));
        console.log(chalk.yellow("   Your node's public key will be transmitted in plaintext."));
        console.log(chalk.yellow("   Use https:// for production gateways."));
      }
      console.log();

      const existingConfig = loadConfig();
      if (existingConfig && existingConfig.state === "active") {
        console.log(chalk.yellow("⚠️  This machine is already paired to a gateway."));
        console.log(chalk.dim(`   Gateway: ${existingConfig.gatewayUrl}`));
        console.log(chalk.dim(`   Run 'openclaw satellite disconnect' first to unpair.`));
        process.exit(1);
      }

      const nodeId = randomUUID();
      const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      // Step 1: Request pairing from the gateway
      try {
        const response = await fetch(`${gatewayUrl}/api/satellite/pair/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeId,
            displayName: opts.name,
            publicKey: publicKey,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          console.log(chalk.red(`❌ Failed to initiate pairing: ${error}`));
          process.exit(1);
        }

        const result = (await response.json()) as {
          nodeId: string;
          pairingCode: string;
          expiresAt: string;
        };

        console.log(chalk.green("✅ Pairing request sent successfully!"));
        console.log();
        console.log(chalk.bold("🔑 Pairing Code:"));
        console.log();
        console.log(chalk.bgCyan.black.bold(`   ${result.pairingCode}   `));
        console.log();
        console.log(chalk.dim("Approve here:"));
        console.log(chalk.cyan(`   ${gatewayUrl}/pair?code=${result.pairingCode}`));
        console.log();
        console.log(chalk.dim("Or enter the code in your Enterprise Admin Dashboard."));
        console.log();

        // Save pending config
        saveConfig({
          nodeId: result.nodeId,
          gatewayUrl,
          displayName: opts.name,
          state: "pending",
          publicKey,
          privateKey,
        });

        // Step 2: Poll for approval
        console.log(chalk.dim("Waiting for admin approval..."));
        const expiresAt = new Date(result.expiresAt).getTime();
        const pollInterval = 2000; // 2 seconds

        while (Date.now() < expiresAt) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          try {
            const statusRes = await fetch(
              `${gatewayUrl}/api/satellite/pair/status/${result.nodeId}`,
            );
            const status = (await statusRes.json()) as { status: string };

            if (status.status === "active") {
              console.log();
              console.log(chalk.green("🎉 Pairing approved! This node is now connected."));

              saveConfig({
                nodeId: result.nodeId,
                gatewayUrl,
                displayName: opts.name,
                state: "active",
                pairedAt: new Date().toISOString(),
                publicKey,
                privateKey,
              });

              console.log();
              console.log(chalk.dim("Run 'openclaw satellite serve' to start the node."));
              return;
            } else if (status.status === "revoked") {
              console.log(chalk.red("❌ Pairing was rejected."));
              deleteConfig();
              process.exit(1);
            }
            // Still pending, continue polling
            process.stdout.write(".");
          } catch {
            // Network error during poll, continue
            process.stdout.write("?");
          }
        }

        console.log();
        console.log(chalk.yellow("⏰ Pairing code expired. Run 'openclaw satellite pair' again."));
        deleteConfig();
        process.exit(1);
      } catch (err) {
        console.log(chalk.red(`❌ Error connecting to gateway: ${err}`));
        process.exit(1);
      }
    });

  // openclaw satellite status
  satellite
    .command("status")
    .description("Show current Satellite Node status")
    .action(async () => {
      const config = loadConfig();

      if (!config) {
        console.log(chalk.dim("This machine is not paired to any gateway."));
        console.log(chalk.dim("Run 'openclaw satellite pair <gateway-url>' to connect."));
        return;
      }

      console.log(chalk.cyan("🛰️  Satellite Node Status"));
      console.log();
      console.log(`  Node ID:      ${chalk.dim(config.nodeId)}`);
      console.log(`  Gateway:      ${config.gatewayUrl}`);
      console.log(`  Display Name: ${config.displayName}`);
      console.log(`  State:        ${formatState(config.state)}`);
      if (config.pairedAt) {
        console.log(`  Paired At:    ${new Date(config.pairedAt).toLocaleString()}`);
      }

      // If active, try to ping the gateway
      if (config.state === "active") {
        try {
          const response = await fetch(
            `${config.gatewayUrl}/api/satellite/nodes/${config.nodeId}/heartbeat`,
            {
              method: "POST",
            },
          );
          if (response.ok) {
            console.log(`  Connection:   ${chalk.green("● Online")}`);
          } else {
            console.log(`  Connection:   ${chalk.yellow("○ Unreachable")}`);
          }
        } catch {
          console.log(`  Connection:   ${chalk.red("✗ Offline")}`);
        }
      }
    });

  // openclaw satellite disconnect
  satellite
    .command("disconnect")
    .description("Disconnect from the Enterprise Gateway")
    .action(async () => {
      const config = loadConfig();

      if (!config) {
        console.log(chalk.dim("This machine is not paired to any gateway."));
        return;
      }

      console.log(chalk.yellow("Disconnecting from gateway..."));

      // Try to notify the gateway
      try {
        await fetch(`${config.gatewayUrl}/api/satellite/nodes/${config.nodeId}/revoke`, {
          method: "POST",
        });
      } catch {
        // Ignore network errors during disconnect
      }

      deleteConfig();
      console.log(chalk.green("✅ Disconnected successfully."));
    });

  satellite
    .command("serve")
    .description("Start the Satellite Node service")
    .action(async () => {
      const config = loadConfig();
      if (!config) {
        console.log(chalk.dim("This machine is not paired to any gateway."));
        console.log(chalk.dim("Run 'openclaw satellite pair <gateway-url>' to connect."));
        return;
      }
      // Dynamic import to avoid circular dependencies if any (though here it is fine)
      // But we can just import it at top level if we want.
      // Since we use replace_file_content, let's add import at top later or use dynamic import here.

      const { runSatelliteServer } = await import("./satellite-server.js");
      await runSatelliteServer(config);
    });
}

function formatState(state: string): string {
  switch (state) {
    case "active":
      return chalk.green("● Active");
    case "pending":
      return chalk.yellow("○ Pending Approval");
    case "disconnected":
      return chalk.dim("○ Disconnected");
    default:
      return chalk.dim(state);
  }
}
