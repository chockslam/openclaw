---
title: "Docker Quickstart"
description: "Deploy OpenClaw Enterprise locally using Docker Compose"
---

# Docker Quickstart Guide

This guide explains how to spin up the entire **OpenClaw Enterprise** stack (Gateway, Dashboard, Database, Redis, Vault) on your local machine using Docker Compose.

## Prerequisites

*   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin)
*   Git
*   (Optional) Node.js (for running Satellite CLI on host)

## 1. Clone the Repository

Clone the Enterprise repository (this is a private repo):

```bash
git clone https://github.com/chockslam/openclaw-enterprise.git
cd openclaw-enterprise
```

## 2. Configuration Setup

The stack requires environment variables for OIDC (Single Sign-On). We provide a template.

1.  Copy the example environment file:
    ```bash
    cp .env.example .env
    ```

2.  Edit `.env` and configure your Identity Provider (Google, Okta, etc.):
    ```bash
    # Required for Admin Login
    OIDC_ISSUER=https://accounts.google.com
    OIDC_CLIENT_ID=your-google-client-id
    OIDC_CLIENT_SECRET=your-google-client-secret
    
    # Optional: Change port if 18789 is taken
    OPENCLAW_GATEWAY_PORT=18789
    ```

    > **Tip**: If you just want to test without real login, you can set dummy values, but the Admin Dashboard login flow will fail. The rest of the system will start.

## 3. Start the Stack

Run the following command to start all services in detached mode:

```bash
docker compose up -d
```

Validating the services:

```bash
docker compose ps
```

You should see 5 healthy containers:
*   `openclaw-enterprise-app-1`: The main Gateway API (Port `18789`)
*   `openclaw-enterprise-dashboard-1`: The Admin UI (Port `3000`)
*   `postgres`: Database (Port `5432`)
*   `redis`: Cache/State (Port `6379`)
*   `vault`: Secrets Management (Port `8200`)

## 4. Access the Dashboard

Open your browser to [http://localhost:3000](http://localhost:3000).

*   Click **"Login with SSO"**.
*   Once authenticated, you will see the **Admin Overview**.

## 5. Next Steps

*   [Connect a Satellite Node](./satellite_network.md) to run browsers/skills on your host machine.
*   [Configure Secrets](./secrets_management.md) in Vault.
