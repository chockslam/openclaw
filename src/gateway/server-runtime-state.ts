import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChannelInterceptor } from "./channel-interceptor.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { AuthProvider } from "./interfaces/auth.js";
import type { ClusterStateAdapter } from "./interfaces/cluster-state.js";
import type { SecretsProvider } from "./interfaces/secrets.js";
import type { StorageAdapter } from "./interfaces/storage.js";
import type { DedupeEntry } from "./server-shared.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import { resolveGatewayListenHosts } from "./net.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { type ChatRunEntry, createChatRunState } from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  /**
   * Optional cluster state adapter for enterprise deployments.
   * When provided, enables distributed state across multiple gateway nodes.
   */
  clusterAdapter?: ClusterStateAdapter;
  /**
   * Optional storage adapter for enterprise deployments.
   * When provided, enables persistent storage (PostgreSQL) instead of files.
   */
  storageAdapter?: StorageAdapter;
  /**
   * Optional auth provider for enterprise deployments.
   * When provided, enables SSO/OIDC authentication.
   */
  authProvider?: AuthProvider;
  /**
   * Optional secrets provider for enterprise deployments.
   * When provided, enables Vault/AWS Secrets Manager integration.
   */
  secretsProvider?: SecretsProvider;
  /**
   * Optional custom handlers (e.g. Admin API, Auth) for enterprise deployments.
   */
  customHandlers?: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>>;
  /**
   * Optional custom Upgrade handlers for enterprise deployments.
   */
  customUpgradeHandlers?: Array<
    (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => boolean
  >;
  agentHookInterceptor?: (
    payload: any,
  ) =>
    | Promise<boolean | { blocked: boolean; response?: string }>
    | boolean
    | { blocked: boolean; response?: string };
  /**
   * Optional channel interceptor for enterprise deployments.
   * Intercepts ALL channel messages before they reach the LLM.
   */
  channelInterceptor?: ChannelInterceptor;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => Promise<void>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => Promise<ChatRunEntry | undefined>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  /**
   * Cluster state adapter (if provided) for enterprise integrations.
   */
  clusterAdapter?: ClusterStateAdapter;
  /**
   * Storage adapter (if provided) for enterprise integrations.
   */
  storageAdapter?: StorageAdapter;
  /**
   * Auth provider (if provided) for enterprise integrations.
   */
  authProvider?: AuthProvider;
  /**
   * Secrets provider (if provided) for enterprise integrations.
   */
  secretsProvider?: SecretsProvider;
}> {
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
    agentHookInterceptor: params.agentHookInterceptor,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      handleHooksRequest,
      handlePluginRequest,
      customHandlers: params.customHandlers,
      resolvedAuth: params.resolvedAuth,
      authProvider: params.authProvider,
      secretsProvider: params.secretsProvider,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  for (const server of httpServers) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      customUpgradeHandlers: params.customUpgradeHandlers,
    });
  }

  const clients = new Set<GatewayWsClient>();
  const { broadcast } = createGatewayBroadcaster({ clients });
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();

  // Pass cluster adapter to chat run state
  const chatRunState = createChatRunState(params.clusterAdapter);
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    clusterAdapter: params.clusterAdapter,
    storageAdapter: params.storageAdapter,
    authProvider: params.authProvider,
    secretsProvider: params.secretsProvider,
  };
}
