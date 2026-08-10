import type {
  AskTimeoutConfig,
  LiveSupervisionEvent,
  PendingSupervisionAsk,
} from "../api/types";

const OPENCLAW_SESSION_KEY_PATTERN =
  /^agent:([A-Za-z0-9._-]{1,64}):([A-Za-z0-9._:-]{1,180})$/;

export function isCanonicalMainAgentSessionKey(
  runtimeSessionId: string | undefined,
): runtimeSessionId is string {
  if (!runtimeSessionId) return false;
  if (runtimeSessionId.includes("..")) return false;
  const match = OPENCLAW_SESSION_KEY_PATTERN.exec(runtimeSessionId);
  return match?.[0] === runtimeSessionId && match[1] === "main";
}

export function addObservedMainSessionKey(
  current: readonly string[],
  event: LiveSupervisionEvent,
): readonly string[] {
  if (
    event.type !== "native_tool_hook" ||
    !isCanonicalMainAgentSessionKey(event.runtimeSessionId) ||
    current.includes(event.runtimeSessionId)
  ) {
    return current;
  }
  return [...current, event.runtimeSessionId];
}

export function collectObservedMainSessionKeys(
  events: LiveSupervisionEvent[],
): string[] {
  let observed: readonly string[] = [];
  for (const event of events) {
    observed = addObservedMainSessionKey(observed, event);
  }
  return [...observed];
}

export type LatestOperationToken = {
  isCurrent(): boolean;
};

export type LatestOperationGate = {
  mount(): void;
  begin(): LatestOperationToken;
  invalidate(): void;
  dispose(): void;
};

export function createLatestOperationGate(): LatestOperationGate {
  let mounted = false;
  let generation = 0;
  return {
    mount() {
      mounted = true;
      generation += 1;
    },
    begin() {
      const operationGeneration = ++generation;
      return {
        isCurrent() {
          return mounted && generation === operationGeneration;
        },
      };
    },
    invalidate() {
      generation += 1;
    },
    dispose() {
      mounted = false;
      generation += 1;
    },
  };
}

export type RealtimeEventSource = {
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};

export type RealtimeStreamOpenOptions = {
  mainUrl: string;
  askUrl: string;
  runtimeSessionId: string | undefined;
  includeHistory: boolean;
};

export type RealtimeStreamController = {
  open(options: RealtimeStreamOpenOptions): void;
  close(): void;
  isOpen(): boolean;
};

export function createRealtimeStreamController(options: {
  eventTypes: readonly LiveSupervisionEvent["type"][];
  createEventSource(url: string): RealtimeEventSource;
  onEvent(
    event: LiveSupervisionEvent,
    context: Pick<RealtimeStreamOpenOptions, "runtimeSessionId" | "includeHistory">,
  ): void;
  onAskConfig(config: AskTimeoutConfig): void;
  onAskDecision(ask: PendingSupervisionAsk): void;
  onAskResolved(ask: PendingSupervisionAsk): void;
  onError(message: string): void;
  onStreamingChange(streaming: boolean): void;
}): RealtimeStreamController {
  let generation = 0;
  let current: {
    generation: number;
    main: RealtimeEventSource;
    ask: RealtimeEventSource;
  } | undefined;

  function closeSources(pair: NonNullable<typeof current>) {
    try {
      pair.main.close();
    } finally {
      pair.ask.close();
    }
  }

  function closeCurrent() {
    generation += 1;
    const pair = current;
    current = undefined;
    if (!pair) return;
    closeSources(pair);
    options.onStreamingChange(false);
  }

  function fail(openGeneration: number, message: string) {
    if (current?.generation !== openGeneration) return;
    closeCurrent();
    options.onError(message);
  }

  return {
    open(openOptions) {
      closeCurrent();
      const openGeneration = ++generation;
      let main: RealtimeEventSource | undefined;
      let ask: RealtimeEventSource | undefined;
      try {
        main = options.createEventSource(openOptions.mainUrl);
        ask = options.createEventSource(openOptions.askUrl);
        current = { generation: openGeneration, main, ask };

        for (const eventType of options.eventTypes) {
          main.addEventListener(eventType, (message) => {
            if (current?.generation !== openGeneration) return;
            options.onEvent(
              JSON.parse(message.data) as LiveSupervisionEvent,
              {
                runtimeSessionId: openOptions.runtimeSessionId,
                includeHistory: openOptions.includeHistory,
              },
            );
          });
        }
        ask.addEventListener("config", (message) => {
          if (current?.generation !== openGeneration) return;
          options.onAskConfig(JSON.parse(message.data) as AskTimeoutConfig);
        });
        ask.addEventListener("ask_decision", (message) => {
          if (current?.generation !== openGeneration) return;
          options.onAskDecision(JSON.parse(message.data) as PendingSupervisionAsk);
        });
        ask.addEventListener("ask_resolved", (message) => {
          if (current?.generation !== openGeneration) return;
          options.onAskResolved(JSON.parse(message.data) as PendingSupervisionAsk);
        });
        main.onerror = () => fail(openGeneration, "实时事件连接失败。");
        ask.onerror = () => fail(openGeneration, "Ask 确认通道连接失败。");
        options.onStreamingChange(true);
      } catch (error) {
        if (current?.generation === openGeneration) current = undefined;
        const partial = main && ask
          ? { generation: openGeneration, main, ask }
          : undefined;
        if (partial) {
          closeSources(partial);
        } else {
          main?.close();
          ask?.close();
        }
        options.onStreamingChange(false);
        throw error;
      }
    },
    close: closeCurrent,
    isOpen() {
      return Boolean(current);
    },
  };
}

export function shouldDisplayRealtimeEvent(
  event: LiveSupervisionEvent,
  runtimeSessionId: string | undefined,
  includeHistory: boolean,
  selectedMainSessionId?: string,
): boolean {
  if (event.type === "native_tool_hook") {
    if (!isCanonicalMainAgentSessionKey(event.runtimeSessionId)) return false;
    if (selectedMainSessionId) {
      return event.runtimeSessionId === selectedMainSessionId;
    }
    return true;
  }
  if (includeHistory) return true;
  if (!event.runtimeSessionId || !runtimeSessionId) return true;
  return event.runtimeSessionId === runtimeSessionId;
}
