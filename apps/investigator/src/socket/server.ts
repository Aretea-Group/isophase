import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { ControlEvent, InvestigationControl } from "../control.ts";
import {
  ControlRequest,
  encodeFrame,
  LineBuffer,
  PROTOCOL_VERSION,
  QueuedWriter,
  type ControlResponse,
} from "./protocol.ts";

/**
 * Serve an `InvestigationControl` over a unix domain socket (PRD-9 §4.1 D4, Phase 4).
 *
 * The watch process owns the loop and the runs; a console attaches to see and steer them. This is
 * the half that makes "the TUI is optional" true in both directions rather than only one: without
 * it, a console watching a separate watch process can read finished artifacts out of `runs/` and
 * nothing else — no live runs, no cancel.
 *
 * It serves the interface and adds nothing. Every method here is a `InvestigationControl` method,
 * and the event stream is its `subscribe`.
 */
export interface ControlServer {
  readonly path: string;
  close(): Promise<void>;
}

export interface ControlServerOptions {
  control: InvestigationControl;
  path: string;
  log?: (message: string) => void;
}

/**
 * Reclaim a socket left behind by a process that died (PRD-9 AC15).
 *
 * A unix socket is a file, and an unclean exit leaves it there. Binding onto it fails, so a watch
 * process that crashed once could never be restarted without someone knowing to delete a path they
 * were never told about — which is exactly the kind of operational papercut an unattended tool
 * cannot afford.
 *
 * The test is whether anything answers, not whether the file exists: a live server must never be
 * displaced by a second one starting. If a connection succeeds the address is genuinely in use and
 * this throws; if it is refused, the file is a corpse and is removed.
 */
export async function reclaimSocketPath(path: string): Promise<boolean> {
  // `existsSync`, not `Bun.file(path).exists()`: a unix socket is not a regular file and the
  // latter answers false for one, which would make this skip the probe for exactly the case it
  // exists to catch — a live server on the path.
  if (!existsSync(path)) return false;
  try {
    const probe = await Bun.connect({ unix: path, socket: { data: () => undefined } });
    probe.end();
    throw new Error(
      `Another watch process is already listening on ${path}. Stop it, or point this one elsewhere.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Another watch process")) throw error;
    // Refused: nothing is listening, so the file is left over from a process that did not exit
    // cleanly. Removing it is the whole point of this function.
    await unlink(path).catch(() => undefined);
    return true;
  }
}

export async function serveControl(options: ControlServerOptions): Promise<ControlServer> {
  const { control, path } = options;
  const log = options.log ?? ((): undefined => undefined);

  // `Bun.listen` will not create the directory it binds in, and the default path lives under
  // `runs/`, which does not exist in a fresh clone until the first artifact is written.
  await mkdir(dirname(path), { recursive: true });

  if (await reclaimSocketPath(path)) {
    log(`[control] reclaimed a stale socket at ${path} — no process was listening on it.`);
  }

  /**
   * One queued writer per client, because `socket.write` is allowed to write less than it is given.
   *
   * Bun returns the byte count and expects the remainder on `drain`. Ignoring it silently truncates
   * exactly the frames that matter most: `run_completed` carries a whole run artifact, which is far
   * past any socket buffer, so the console would receive a half-frame and drop it as unparseable.
   */
  const clients = new Set<QueuedWriter>();

  const unsubscribe = control.subscribe((event: ControlEvent) => {
    const frame = encodeFrame({ type: "event", event });
    // A copy: a client that errors is dropped from the set while this is iterating.
    const current = [...clients];
    for (const client of current) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = Bun.listen<{ buffer: LineBuffer; writer: QueuedWriter }>({
    unix: path,
    socket: {
      open(socket) {
        const writer = new QueuedWriter(socket);
        socket.data = { buffer: new LineBuffer(), writer };
        clients.add(writer);
        writer.write(encodeFrame({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
      },
      close(socket) {
        clients.delete(socket.data.writer);
      },
      error(socket) {
        clients.delete(socket.data.writer);
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      data(socket, chunk) {
        for (const line of socket.data.buffer.push(chunk)) {
          void handle(socket.data.writer, line);
        }
      },
    },
  });

  async function handle(socket: QueuedWriter, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = ControlRequest.parse(JSON.parse(line));
    } catch (error) {
      // Unparseable frames are dropped rather than answered: there is no id to answer *to*, and
      // guessing one would resolve a caller's unrelated request.
      log(`[control] dropped an unreadable frame — ${describe(error).message}`);
      return;
    }

    const reply = (response: ControlResponse): void => {
      try {
        socket.write(encodeFrame(response));
      } catch {
        // The client went away mid-call. Its own reconnect is the recovery.
      }
    };

    try {
      switch (request.method) {
        case "listAlerts":
          reply({ id: request.id, ok: true, result: await control.listAlerts() });
          return;
        case "listModels":
          reply({ id: request.id, ok: true, result: await control.listModels() });
          return;
        case "listTools":
          reply({ id: request.id, ok: true, result: [...control.listTools()] });
          return;
        case "live":
          reply({ id: request.id, ok: true, result: control.live() });
          return;
        case "cancel":
          control.cancel(request.runId);
          reply({ id: request.id, ok: true });
          return;
        case "shutdown":
          control.shutdown();
          reply({ id: request.id, ok: true });
          return;
        case "start": {
          // `settled` is not sent: a promise does not cross a socket. The client rebuilds it from
          // the terminal event for this `runId`, which is the same fact arriving by the route that
          // can carry it.
          const started = control.start(request.request);
          reply({ id: request.id, ok: true, result: { runId: started.runId } });
          return;
        }
      }
    } catch (error) {
      reply({ id: request.id, ok: false, error: describe(error) });
    }
  }

  log(`[control] listening on ${path}`);

  return {
    path,
    close: async () => {
      unsubscribe();
      server.stop(true);
      await unlink(path).catch(() => undefined);
    },
  };
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}
