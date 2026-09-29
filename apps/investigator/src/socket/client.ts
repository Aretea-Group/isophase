import type { SecurityAlert } from "@soc/contracts";

import type {
  ControlEvent,
  InvestigationControl,
  LiveRun,
  RunHandle,
  StartRequest,
} from "../control.ts";
import type { ModelChoice } from "../model.ts";
import {
  encodeFrame,
  LineBuffer,
  QueuedWriter,
  ServerFrame,
  type ControlResponse,
} from "./protocol.ts";

/**
 * `InvestigationControl` over a unix domain socket (PRD-10 §4.1 D4).
 *
 * ADR 007 said in-process execution was one implementation and "a spawned child or a queue worker
 * is another, swappable without the caller changing". This is that second implementation, and the
 * claim holds: the console's panes are untouched by Phase 4, because they depend on the interface
 * and never on what is behind it.
 */
export class RemoteInvestigationControl implements InvestigationControl {
  readonly #socket: Awaited<ReturnType<typeof Bun.connect>>;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #listeners = new Set<(event: ControlEvent) => void>();
  /**
   * Resolvers for `RunHandle.settled`, keyed by run.
   *
   * A promise cannot cross a socket, so the handle the server returns carries only a `runId`. The
   * settlement is rebuilt here from the terminal event for that run — which is the same fact, by
   * the only route that can carry it. Kept in a map rather than on the handle so an event for a run
   * this client did not start (the loop's own, most of the time) still resolves any handle waiting.
   */
  readonly #settlers = new Map<string, () => void>();

  readonly #writer: QueuedWriter;

  private constructor(socket: Awaited<ReturnType<typeof Bun.connect>>) {
    this.#socket = socket;
    this.#writer = new QueuedWriter(socket);
  }

  /** Called from the socket's `drain`, so a large request is not truncated either. */
  drain(): void {
    this.#writer.flush();
  }

  static async connect(path: string): Promise<RemoteInvestigationControl> {
    let client: RemoteInvestigationControl | undefined;
    const buffer = new LineBuffer();
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_socket, chunk) => {
          for (const line of buffer.push(chunk)) client?.receive(line);
        },
        drain: () => client?.drain(),
        close: () => client?.failAll(new Error("The control socket closed.")),
        error: () => client?.failAll(new Error("The control socket errored.")),
      },
    });
    client = new RemoteInvestigationControl(socket);
    return client;
  }

  receive(line: string): void {
    let frame: ServerFrame;
    try {
      frame = ServerFrame.parse(JSON.parse(line));
    } catch {
      /**
       * An unreadable frame must not be dropped in silence.
       *
       * It used to `return`, which left the request it was answering pending for the lifetime of
       * the process — no error, no timeout, nothing to see. That is how a corrupted `listAlerts`
       * reply presented: the console's alert queue simply stayed empty forever while every other
       * call worked. Failing the waiting callers is worse than answering them and far better than
       * hanging them, and the id cannot be recovered from a frame that would not parse.
       */
      this.failAll(new Error("The control socket delivered a frame this client could not read."));
      return;
    }
    if ("type" in frame && frame.type === "hello") return;
    if ("type" in frame && frame.type === "event") {
      const event = frame.event as unknown as ControlEvent;
      if (
        event.type === "run_completed" ||
        event.type === "run_failed" ||
        event.type === "run_cancelled"
      ) {
        this.#settlers.get(event.runId)?.();
        this.#settlers.delete(event.runId);
      }
      const current = [...this.#listeners];
      for (const listener of current) listener(event);
      return;
    }
    const response = frame as ControlResponse;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(Object.assign(new Error(response.error.message), response.error));
  }

  failAll(error: Error): void {
    for (const [, pending] of this.#pending) pending.reject(error);
    this.#pending.clear();
    // Waiting handles are released too: a caller awaiting `settled` across a dropped socket would
    // otherwise hang for the process lifetime with nothing left to resolve it.
    for (const [, settle] of this.#settlers) settle();
    this.#settlers.clear();
  }

  async #call(request: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#writer.write(encodeFrame({ ...request, id }));
    return promise;
  }

  async listAlerts(): Promise<SecurityAlert[]> {
    return (await this.#call({ method: "listAlerts" })) as SecurityAlert[];
  }

  async listModels(): Promise<ModelChoice[]> {
    return (await this.#call({ method: "listModels" })) as ModelChoice[];
  }

  /**
   * Cached at connect time would be wrong; this is synchronous by interface and async on the wire.
   *
   * The interface returns `readonly string[]`, so the tool list is fetched eagerly on first use and
   * returned from there. A console calling this before the first fetch completes sees an empty
   * list once, which is honest — it does not yet know.
   */
  #tools: readonly string[] = [];
  listTools(): readonly string[] {
    this.#background(
      this.#call({ method: "listTools" }).then((result) => {
        this.#tools = result as string[];
        return undefined;
      }),
    );
    return this.#tools;
  }

  start(request: StartRequest): RunHandle {
    const settled = new Promise<void>((resolve) => {
      this.#settlers.set(request.runId, resolve);
    });
    this.#background(
      this.#call({ method: "start", request }).catch(() => {
        // The start never reached the server, so no terminal event is coming for it. Release the
        // handle rather than leaving a caller awaiting `settled` for the process lifetime.
        this.#settlers.get(request.runId)?.();
        this.#settlers.delete(request.runId);
      }),
    );
    return { runId: request.runId, settled };
  }

  cancel(runId: string): void {
    this.#background(this.#call({ method: "cancel", runId }));
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  live(): LiveRun[] {
    // Synchronous by interface; the wire is not. The last known set is returned and refreshed in
    // the background, which is what a polling renderer wants anyway.
    this.#background(
      this.#call({ method: "live" }).then((result) => {
        this.#live = result as LiveRun[];
        return undefined;
      }),
    );
    return this.#live;
  }
  #live: LiveRun[] = [];

  shutdown(): void {
    this.#background(this.#call({ method: "shutdown" }));
  }

  /**
   * Swallow a rejection nobody is waiting for.
   *
   * `live`, `listTools`, `cancel` and `shutdown` are synchronous by interface and asynchronous on
   * the wire, so their promises have no caller to reject to. Left bare, a disconnect rejects all of
   * them at once as unhandled — and PRD-5 §5.4 records what an uncaught rejection does to the
   * console: it destroys the renderer and exits. The socket dropping must not take the TUI with it.
   */
  #background(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }

  /** Detach without stopping the loop (PRD-10 AC14). Closing a client is not a shutdown. */
  detach(): void {
    this.#socket.end();
  }

  /** Kept as the name the socket tests use; `detach` is what the interface asks for. */
  disconnect(): void {
    this.detach();
  }
}
