---
title: "Deployment Guide"
description: "How to deploy OpenClaw Enterprise on Kubernetes"
---

# Enterprise Deployment Guide

This guide explains how to deploy OpenClaw in a High-Availability (HA) configuration for enterprise environments using Kubernetes.

## Architecture

The Enterprise deployment consists of:

*   **Gateway Cluster**: 3+ stateless replicas of the OpenClaw Gateway.
*   **Redis**: Shared in-memory state for `chatRunState` and Pub/Sub events.
*   **PostgreSQL**: Persistent storage for sessions, users, and audit logs.
*   **Ingress Controller**: SSL termination and load balancing (AWS ALB, Nginx).

## Prerequisites

*   Kubernetes Cluster (EKS, GKE, AKS, or on-prem).
*   Helm v3+.
*   External Redis and PostgreSQL instances (managed services recommended, e.g., Amazon ElastiCache / RDS).

## Installation

We provide a Helm chart for enterprise deployments.

```bash
helm repo add openclaw https://charts.openclaw.ai
helm repo update
```

Create a `values.yaml` file for your environment:

```yaml
# values.yaml
replicaCount: 3

image:
  repository: openclaw/enterprise
  tag: 2026.2.1

gateway:
  config:
    # Enable Clustering Adapters
    cluster:
      backend: "redis"
      url: "redis://your-redis-endpoint:6379"
    
    storage:
      driver: "postgres"
      url: "postgres://user:pass@your-db-endpoint:5432/openclaw"
    
    auth:
      provider: "oidc"
      issuer: "https://your-idp.com"
      clientId: "openclaw-app"
```

Deploy to your cluster:

```bash
helm install openclaw openclaw/enterprise -f values.yaml
```

## Verification

Check the pods are running:

```bash
kubectl get pods
```

You should see 3 gateway pods. If you kill one, the others will handle traffic, ensuring zero downtime.
