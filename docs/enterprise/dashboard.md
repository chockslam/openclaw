---
title: "Admin Dashboard"
description: "Managing OpenClaw Enterprise via the Admin UI"
---

# Admin Dashboard

The Enterprise Edition includes a dedicated Admin Dashboard ("The Pane of Glass") for managing your OpenClaw fleet.

## Accessing the Dashboard

The dashboard is served at `/admin` on your Gateway URL. Access is restricted to users with the `admin` role in your Identity Provider.

## Features

### 1. User Management
View and manage all users who have interacted with the bot.
*   **Grant/Revoke Roles**: Assign `developer`, `support`, or `viewer` roles.
*   **Session Kill**: Forcefully terminate active sessions for security.

### 2. Audit Logs
A searchable view of all system activity.
*   Filter by User, Command, or Time range.
*   Export logs to CSV for compliance reporting.

### 3. Usage & Billing
Track token consumption across the organization.
*   **Cost Attribution**: See spend per Department or Team.
*   **Quotas**: Set monthly limits to prevent cost overruns.

### 4. Secrets Management
Securely manage API keys for third-party tools.
*   Connect to **HashiCorp Vault** or AWS Secrets Manager.
*   Rotate keys without restarting the application.
