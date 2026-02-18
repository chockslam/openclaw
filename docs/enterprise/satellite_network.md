---
title: "Satellite Network"
description: "Connecting Host machines to the Enterprise Gateway for secure execution."
---

# Satellite Network Guide

A **Satellite Node** is a lightweight OpenClaw runtime that connects to the central Gateway. It allows you to execute commands, open browsers, and run skills on your local machine (Host) while the core intelligence runs in the cloud or Docker container (Gateway).

This setup is ideal for development, where you want to use your local browser or specific tools, but keep the heavy lifting on a server.

## Overview

```
[ Your Laptop (Host) ] <--- WebSocket (Secure Tunnel) ---> [ Enterprise Gateway (Docker/Cloud) ]
    |                                                           |
    +-- Running Browser                                         +-- LLM Intelligence
    +-- Running Local Tools                                     +-- Database / Memory
```

## 1. Prerequisites

### On the Host Machine (Your Laptop/Server)
*   **Node.js 22+** (recommended)
*   Access to the Gateway URL (e.g., `http://localhost:18789`)

## 2. Running a Satellite

There are two ways to run a satellite:
1.  **Usage via CLI (`npx`)**: Best for developers.
2.  **Usage via Binary**: Best for servers/CI.

### Method A: Using `npx` (No Installation Required)

If you have Node.js installed, simply run:

```bash
npx @chockslam/openclaw satellite pair http://localhost:18789 --name "My Laptop"
```

*   Replace `http://localhost:18789` with your actual gateway URL.
*   The `--name` flag is optional but helps identify the node in the dashboard.

### Method B: Using Binary

Download the executable for your OS (Linux, macOS, Windows) from the Releases page.

```bash
# Linux / macOS
./openclaw satellite pair http://localhost:18789

# Windows
.\openclaw.exe satellite pair http://localhost:18789
```

## 3. Pairing Process

1.  **Initiate Pairing**: When you run the `pair` command above, the terminal will display a **6-digit Pairing Code**.
    ```
    🛰️  Initiating Satellite Node pairing...
    Gateway: http://localhost:18789
    Node name: My Laptop

    ✅ Pairing request sent successfully!

    🔑 Pairing Code:
       123456
    
    Waiting for admin approval...
    ```

2.  **Approve Request**:
    *   Open the **Admin Dashboard** (e.g., `http://localhost:3000/admin`).
    *   Navigate to **Nodes > Pending Requests**.
    *   Find the request from "My Laptop" and click **Approve**.

3.  **Connected**:
    *   Once approved, your terminal will update:
        ```
        🎉 Pairing approved! This node is now connected.
        ```
    *   The satellite process remains running in the background (if started via `serve`) or as a configured client.

## 4. Operational Commands

### Check Status
Verify if your machine is currently connected to a gateway.

```bash
npx @chockslam/openclaw satellite status
# or
openclaw satellite status
```

### Start the Service
If you stopped the process, you can restart the background service without re-pairing.

```bash
npx @chockslam/openclaw satellite serve
```

### Disconnect
To unpair this machine and revoke its credentials:

```bash
npx @chockslam/openclaw satellite disconnect
```

## Troubleshooting

*   **"Connection Refused"**: Ensure the Gateway is running and accessible from your host. If running in Docker, ensure port `18789` is mapped.
*   **"Pairing Expired"**: Codes expire after 5 minutes. Run `pair` again to generate a new code.
*   **"Already Paired"**: Run `disconnect` first if you need to switch gateways.
