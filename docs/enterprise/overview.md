---
title: "Enterprise Overview"
description: "Architecture and features of OpenClaw Enterprise"
---

# OpenClaw Enterprise

OpenClaw Enterprise is designed for organizations requiring High Availability, Security, and Compliance. It extends the open-source core with clustering, SSO, and audit capabilities.

## Key Features

| Feature | Open Source (Lite) | Enterprise |
| :--- | :--- | :--- |
| **State Storage** | In-Memory (RAM) | Redis Cluster |
| **Session Storage** | JSON Files (Local Disk) | PostgreSQL Database |
| **Authentication** | Shared Token / Password | SSO / OIDC / SAML |
| **Scaling** | Single Node | Horizontal Scaling (3+ Nodes) |
| **Availability** | Downtime on Restart | Zero-Downtime Updates |
| **Audit Logs** | Text Logs | Structured JSON / SIEM Export |

## Architecture

The Enterprise architecture uses an **Adapter Pattern** to plug into corporate infrastructure.

```mermaid
graph TD
    User[Users] --> LB[Load Balancer]
    LB --> G1[Gateway 1]
    LB --> G2[Gateway 2]
    LB --> G3[Gateway 3]
    
    G1 & G2 & G3 --> Redis[Redis (Hot State)]
    G1 & G2 & G3 --> DB[(PostgreSQL)]
    
    G1 & G2 & G3 --> IDP[Identity Provider (Okta/AD)]
```

## Why Upgrade?

*   **Zero Downtime**: Run updates without disconnecting active users.
*   **Security**: Integrate with your existing Identity Provider (Okta, Azure AD) for centralized user management.
*   **Compliance**: Full audit trails of every command executed by the AI agent.
