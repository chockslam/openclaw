import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: (reason?: string) => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};

export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
  label?: string;
}): TypingController {
  const {
    onReplyStart,
    typingIntervalSeconds = 6,
    typingTtlMs = 2 * 60_000,
    silentToken = SILENT_REPLY_TOKEN,
    log,
    label,
  } = params;
  const typingDebugRaw = (process.env.OPENCLAW_DEBUG_TYPING ?? "").trim().toLowerCase();
  const typingDebugEnabled =
    typingDebugRaw === "1" ||
    typingDebugRaw === "true" ||
    typingDebugRaw === "yes" ||
    typingDebugRaw === "on";
  const logger = log ?? ((message: string) => console.log(message));
  const debug = (message: string) => {
    if (!typingDebugEnabled) {
      return;
    }
    const prefix = label ? `[typing][${label}]` : "[typing]";
    logger(`${prefix} ${message}`);
  };
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  // Important: callbacks (tool/block streaming) can fire late (after the run completed),
  // especially when upstream event emitters don't await async listeners.
  // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
  let sealed = false;
  let typingTimer: NodeJS.Timeout | undefined;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = typingIntervalSeconds * 1000;

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };
  debug(
    `controller created interval=${typingIntervalSeconds}s ttl=${formatTypingTtl(typingTtlMs)} onReplyStart=${
      typeof onReplyStart === "function"
    }`,
  );

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = (reason = "unknown") => {
    if (sealed) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    resetCycle();
    sealed = true;
    debug(`cleanup reason=${reason}`);
  };

  const refreshTypingTtl = (reason = "unspecified") => {
    if (sealed) {
      return;
    }
    if (!typingIntervalMs || typingIntervalMs <= 0) {
      return;
    }
    if (typingTtlMs <= 0) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingTimer) {
        return;
      }
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup("ttl");
    }, typingTtlMs);
    debug(`ttl refreshed reason=${reason}`);
  };

  const isActive = () => active && !sealed;

  const triggerTyping = async () => {
    if (sealed) {
      return;
    }
    debug("trigger onReplyStart");
    await onReplyStart?.();
  };

  const ensureStart = async () => {
    if (sealed) {
      debug("ensureStart ignored sealed=true");
      return;
    }
    // Late callbacks after a run completed should never restart typing.
    if (runComplete) {
      debug("ensureStart ignored runComplete=true");
      return;
    }
    if (!active) {
      active = true;
    }
    if (started) {
      return;
    }
    started = true;
    debug("ensureStart starting typing");
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    debug(`maybeStopOnIdle runComplete=${runComplete} dispatchIdle=${dispatchIdle}`);
    if (runComplete && dispatchIdle) {
      cleanup("run-complete+dispatch-idle");
    }
  };

  const startTypingLoop = async () => {
    if (sealed) {
      debug("startTypingLoop ignored sealed=true");
      return;
    }
    if (runComplete) {
      debug("startTypingLoop ignored runComplete=true");
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl("start-typing-loop");
    if (!onReplyStart) {
      debug("startTypingLoop skipped no onReplyStart");
      return;
    }
    if (typingIntervalMs <= 0) {
      return;
    }
    if (typingTimer) {
      return;
    }
    await ensureStart();
    typingTimer = setInterval(() => {
      debug("typing interval tick");
      void triggerTyping();
    }, typingIntervalMs);
    debug(`typing loop started intervalMs=${typingIntervalMs}`);
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      debug("startTypingOnText ignored sealed=true");
      return;
    }
    const trimmed = text?.trim();
    if (!trimmed) {
      debug("startTypingOnText ignored empty-text");
      return;
    }
    if (silentToken && isSilentReplyText(trimmed, silentToken)) {
      debug("startTypingOnText ignored silent-token");
      return;
    }
    debug(`startTypingOnText len=${trimmed.length}`);
    refreshTypingTtl("text-delta");
    await startTypingLoop();
  };

  const markRunComplete = () => {
    runComplete = true;
    debug("markRunComplete");
    maybeStopOnIdle();
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    debug("markDispatchIdle");
    maybeStopOnIdle();
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    cleanup,
  };
}
