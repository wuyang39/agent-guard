import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import {
  FileMarkerStore,
  LeaseRegistry,
  type LeaseLookup,
  type MarkerStore,
} from "./leaseRegistry";

export type AgentGuardRuntimeOptions = {
  markerStore?: MarkerStore;
  markerDir?: string;
  now?: () => Date;
};

const OFF_STATUS: Readonly<NativeGuardStatus> = Object.freeze({
  coverage: "off",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
});

export class AgentGuardRuntime {
  readonly registry: LeaseRegistry;
  #startPromise: Promise<void> | undefined;
  #started = false;

  constructor(options: AgentGuardRuntimeOptions = {}) {
    const markerStore = options.markerStore ?? new FileMarkerStore(
      options.markerDir ?? join(homedir(), ".agent-guard", "native-guard-markers"),
    );
    this.registry = new LeaseRegistry({ markerStore, now: options.now });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#startPromise ??= this.registry.start().then(() => {
      this.#started = true;
    }).catch((error: unknown) => {
      this.#startPromise = undefined;
      throw error;
    });
    await this.#startPromise;
  }

  async lookup(sessionKey: string): Promise<LeaseLookup> {
    if (!this.#started) return { state: "off" };
    return this.registry.lookup(sessionKey);
  }

  async status(): Promise<NativeGuardStatus> {
    if (!this.#started) return { ...OFF_STATUS };
    return this.registry.status();
  }
}
