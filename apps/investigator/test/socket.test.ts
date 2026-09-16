import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecurityAlert } from "@soc/contracts";

import type { ControlEvent, InvestigationControl, LiveRun, StartRequest } from "../src/control.ts";
import { RemoteInvestigationControl } from "../src/socket/client.ts";
import { reclaimSocketPath, serveControl, type ControlServer } from "../src/socket/server.ts";

/**
 * PRD-9 Phase 4 — the control socket, over a real unix socket rather than a stubbed transport.
 *
 * A fake transport would prove the call shapes and nothing about the thing that actually breaks:
 * frame boundaries. A `run_completed` carrying an artifact does not arrive in one chunk, and two
 * short frames do arrive in one — `LineBuffer` exists for exactly that, and only a real socket
 * exercises it.
 */

const scratchDirs: string[] = [];
const servers: ControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soc-control-"));
  scratchDirs.push(dir);
  return join(dir, "control.sock");
}

function alert(id: string): SecurityAlert {
  return {
    id,
    title: `alert ${id}`,
    description: "d",
    tactics: [],
    techniques: [],
    entities: [],
    native: { id },
  };
}

/** A control that never finishes a run on its own, so a test decides when each one settles. */
function stubControl(): {
  control: InvestigationControl;
  emit: (event: ControlEvent) => void;
  cancelled: string[];
  shutdowns: () => number;
} {
  const listeners = new Set<(event: ControlEvent) => void>();
  const live: LiveRun[] = [];
  const cancelled: string[] = [];
  let shutdowns = 0;
  const emit = (event: ControlEvent): void => {
    const current = [...listeners];
    for (const listener of current) listener(event);
  };
  return {
    cancelled,
    emit,
    shutdowns: () => shutdowns,
    control: {
      listAlerts: () => Promise.resolve([alert("a1"), alert("a2")]),
      listModels: () => Promise.resolve([{ provider: "openai", id: "faux" }] as never),
      listTools: () => ["query_security_data", "submit_investigation"],
      start: (request: StartRequest) => {
        live.push({ runId: request.runId, alertId: request.alertId, startedAt: "now" });
        return { runId: request.runId, settled: new Promise<void>(() => undefined) };
      },
      cancel: (runId: string) => {
        cancelled.push(runId);
        emit({ type: "run_cancelled", runId, alertId: "a1" });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      live: () => live,
      shutdown: () => void (shutdowns += 1),
    },
  };
}

async function connected(): Promise<{
  client: RemoteInvestigationControl;
  stub: ReturnType<typeof stubControl>;
  path: string;
}> {
  const path = await socketPath();
  const stub = stubControl();
  servers.push(await serveControl({ control: stub.control, path }));
  return { client: await RemoteInvestigationControl.connect(path), stub, path };
}

/** The wire is asynchronous; a synchronous-by-interface reader needs one turn to catch up. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("the control socket (PRD-9 §4.1 D4)", () => {
  test("AC12 — Given a running watch process, When a console attaches, Then it lists live runs and receives events for a run it did not start", async () => {
    const { client, stub } = await connected();

    // Started on the server side, exactly as the loop would — this client never called `start`.
    stub.control.start({ runId: "run-loop", alertId: "a1" });

    const seen: ControlEvent[] = [];
    client.subscribe((event) => seen.push(event));
    stub.emit({ type: "turn", runId: "run-loop", alertId: "a1", turn: 3 });
    await settle();

    client.live();
    await settle();
    expect(client.live().map((run) => run.runId)).toEqual(["run-loop"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: "turn", runId: "run-loop", alertId: "a1", turn: 3 });
  });

  test("AC12 — a frame split across socket reads still arrives as one event", async () => {
    const { client, stub } = await connected();
    const seen: ControlEvent[] = [];
    client.subscribe((event) => seen.push(event));

    // `assistant_text` long enough that the kernel will not hand it over in one chunk.
    const text = "x".repeat(200_000);
    stub.emit({ type: "assistant_text", runId: "r1", alertId: "a1", text });
    await settle();

    expect(seen).toHaveLength(1);
    expect((seen[0] as { text: string }).text).toHaveLength(200_000);
  });

  test("AC13 — Given an attached console, When it cancels a run the loop started, Then that run is cancelled", async () => {
    const { client, stub } = await connected();
    stub.control.start({ runId: "run-loop", alertId: "a1" });

    client.cancel("run-loop");
    await settle();

    expect(stub.cancelled).toEqual(["run-loop"]);
    // Cancelling one run is not a shutdown: the loop keeps going to the next alert.
    expect(stub.shutdowns()).toBe(0);
  });

  test("AC14 — Given an attached console, When it detaches, Then the server keeps running and serves the next client", async () => {
    const { client, stub, path } = await connected();
    expect(await client.listAlerts()).toHaveLength(2);

    client.disconnect();
    await settle();

    // The loop is untouched by a console going away — no shutdown, and a second console attaches
    // to the same still-running process.
    expect(stub.shutdowns()).toBe(0);
    const second = await RemoteInvestigationControl.connect(path);
    expect(await second.listAlerts()).toHaveLength(2);
    second.disconnect();
  });

  test("AC15 — Given a socket file left by a dead process, When a new server starts, Then it reclaims the path", async () => {
    const path = await socketPath();
    // A file where the socket should be, with nothing listening: what an unclean exit leaves.
    await writeFile(path, "");

    expect(await reclaimSocketPath(path)).toBe(true);

    const stub = stubControl();
    servers.push(await serveControl({ control: stub.control, path }));
    const client = await RemoteInvestigationControl.connect(path);
    expect(await client.listAlerts()).toHaveLength(2);
  });

  test("AC15 — a live server is never displaced by a second one starting", async () => {
    const { path } = await connected();

    // The file exists *and* something answers. Removing it here would strand a running loop's
    // console and let two processes serve the same path.
    await expect(reclaimSocketPath(path)).rejects.toThrow("already listening");
  });

  test("a request that the control rejects comes back as an error, not a hang", async () => {
    const path = await socketPath();
    const stub = stubControl();
    const failing: InvestigationControl = {
      ...stub.control,
      listAlerts: () => Promise.reject(new Error("the source is unreachable")),
    };
    servers.push(await serveControl({ control: failing, path }));
    const client = await RemoteInvestigationControl.connect(path);

    await expect(client.listAlerts()).rejects.toThrow("the source is unreachable");
  });

  test("a reply too large for one write survives non-ASCII content intact", async () => {
    const path = await socketPath();
    const stub = stubControl();
    /**
     * The payload has to be big enough that the socket accepts it in pieces *and* carry non-ASCII,
     * because only that combination breaks: `socket.write` returns bytes, and the writer used to
     * advance a UTF-16 string by that count, deleting characters from the middle of the frame. The
     * receiver dropped the unreadable line in silence and the caller waited forever.
     *
     * Measured live before the fix: a 205 KB `listAlerts` reply went out over 27 partial writes and
     * arrived 36 characters short, as unparseable JSON.
     */
    const big: SecurityAlert[] = Array.from({ length: 400 }, (_, index) => ({
      ...alert(`a${index}`),
      description: `${"café — naïve ✓ ".repeat(40)}${index}`,
    }));
    const serving: InvestigationControl = {
      ...stub.control,
      listAlerts: () => Promise.resolve(big),
    };
    servers.push(await serveControl({ control: serving, path }));
    const client = await RemoteInvestigationControl.connect(path);

    expect(await client.listAlerts()).toEqual(big);
  });
});
