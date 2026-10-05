#!/usr/bin/env bun
/* oxlint-disable eslint/no-await-in-loop --
 * Every Graph call in this file is deliberately serial and paced. Advanced hunting bills against a
 * shared per-tenant CPU allowance that blocks *everything else in the tenant* until the next
 * 15-minute cycle once exhausted, and documents "at least 45 calls per minute". A probe that
 * parallelised its calls could take the tenant's hunting offline for a quarter of an hour to answer
 * questions that are not urgent.
 */
/**
 * PRD-8 Phase 0 — probe the Microsoft Graph security API against a real tenant.
 *
 *     isophase probe                       # every section
 *     isophase probe --only A,C,D          # one or more sections
 *     isophase probe --pace-ms 2000        # slower than the 45/min floor
 *     isophase probe --skip-table-probe    # skip the per-table existence sweep
 *
 * From a clone, `bun run probe:defender` reaches the same code through the dispatcher
 * (`apps/cli/src/index.ts`, PRD-11 §4.1 D3). The file moved here from `scripts/` so the published
 * bundle can reach it; `scripts/` stays the one tree the ground-truth guards exempt, and this file
 * is scanned like every other under `apps/cli/src`.
 *
 * PRD-8 §4.1 D12 makes this the gate on the whole PRD: no connector code lands until this has run
 * and its findings are recorded in `docs/research-defender-api.md`. Several design choices in the
 * PRD are stated as options with a decision procedure rather than as answers — schema discovery,
 * result-key casing, the `alertType` mapping — because Microsoft's documentation is thin or
 * self-contradictory on each. This script is what closes them.
 *
 * **Deliberately dependency-free.** The Phase 1 connector will authenticate with
 * `ClientSecretCredential` from `@azure/identity` (D3), but the probe does the client-credentials
 * flow with `fetch` for two reasons. §7 Q10 asks what an *unconsented* app registration actually
 * does — whether the token endpoint refuses or issues a role-less token — and an Azure Identity
 * wrapper answers that question by hiding it behind its own error type. And `scripts/` sits outside
 * every workspace package under Bun's isolated linker, so a bare `@azure/identity` import would not
 * resolve here anyway.
 *
 * **Writes only under `.data/`** (PRD-8 §5, AC14). Two files per run: `transcript.json`, which is
 * every request and response verbatim and may contain tenant data, and `findings.md`, which is
 * scrubbed of tenant identifiers and is the thing that gets read into the research note. The client
 * secret and the access token are redacted from both — `.data/` is ignored by git, not by a laptop.
 *
 * Nothing here is a connector, and nothing here may become one. It records what the service does;
 * `packages/sentinel-client` is where a decision about it gets implemented, in Phase 1.
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { CommandModule } from "./command-module.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const LOGIN_HOST = "https://login.microsoftonline.com";

/** Root every artifact of this script must sit under (PRD-8 §4.1 D10, AC14). */
const DATA_ROOT = ".data";

/**
 * Without this header twenty-one evolvable enum members collapse to `unknownFutureValue` —
 * including `microsoftSentinel` itself and every Sentinel rule kind. `serviceSource` is also the
 * only filterable field that says where an alert came from, so omitting it would erase the source
 * distinction PRD-8 exists to make (§4.2 "Listing alerts").
 */
const PREFER_UNKNOWN_ENUMS = "include-unknown-enum-members";

/**
 * A table name no tenant holds, used two ways: as the absent half of the `union isfuzzy=true` test
 * (mechanism 2), and as a control on the existence sweep (mechanism 3) — a sweep that reports this
 * one *present* is not discriminating and its whole result is void.
 */
const CANARY_TABLE = "ProbeCanaryTableThatDoesNotExist";

/**
 * Candidate advanced-hunting tables, from the published schema reference.
 *
 * This is a candidate list and not an enumeration, which is the point of §7 Q1: Graph exposes no
 * metadata endpoint, no special table and no enumeration query, so *every* discovery mechanism the
 * PRD lists starts from a list somebody wrote down. What the sweep below establishes is which of
 * these the tenant actually holds — a function of its licences, not of the schema reference.
 */
const CANDIDATE_TABLES = [
  // Alerts
  "AlertEvidence",
  "AlertInfo",
  // Apps and identities
  "AADSignInEventsBeta",
  "AADSpnSignInEventsBeta",
  "CloudAppEvents",
  "IdentityDirectoryEvents",
  "IdentityInfo",
  "IdentityLogonEvents",
  "IdentityQueryEvents",
  "OAuthAppInfo",
  // Devices
  "DeviceEvents",
  "DeviceFileCertificateInfo",
  "DeviceFileEvents",
  "DeviceImageLoadEvents",
  "DeviceInfo",
  "DeviceLogonEvents",
  "DeviceNetworkEvents",
  "DeviceNetworkInfo",
  "DeviceProcessEvents",
  "DeviceRegistryEvents",
  // Email and collaboration
  "EmailAttachmentInfo",
  "EmailEvents",
  "EmailPostDeliveryEvents",
  "EmailUrlInfo",
  "UrlClickEvents",
  // Vulnerability management
  "DeviceTvmBrowserExtensions",
  "DeviceTvmBrowserExtensionsKB",
  "DeviceTvmCertificateInfo",
  "DeviceTvmHardwareFirmware",
  "DeviceTvmInfoGathering",
  "DeviceTvmInfoGatheringKB",
  "DeviceTvmSecureConfigurationAssessment",
  "DeviceTvmSecureConfigurationAssessmentKB",
  "DeviceTvmSoftwareInventory",
  "DeviceTvmSoftwareVulnerabilities",
  "DeviceTvmSoftwareVulnerabilitiesKB",
  // Behaviours, exposure and cloud audit
  "BehaviorEntities",
  "BehaviorInfo",
  "CloudAuditEvents",
  "ExposureGraphEdges",
  "ExposureGraphNodes",
] as const;

/**
 * Tables an investigation actually reaches, for the row-width sample.
 *
 * D15 needs a number, not a policy: `DEFENDER_QUERY_MAX_ROWS` must be high enough that a realistic
 * projection runs out of characters before it runs out of rows, and low enough that a runaway query
 * cannot drag 100,000 rows across. That band is a function of how wide a row actually serialises,
 * which is a property of these tables and of this tenant's data.
 */
const ROW_WIDTH_TABLES = [
  "AlertEvidence",
  "AlertInfo",
  "CloudAppEvents",
  "DeviceNetworkEvents",
  "DeviceProcessEvents",
  "EmailEvents",
  "IdentityLogonEvents",
] as const;

const SECTION_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
type SectionId = (typeof SECTION_IDS)[number];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ProbeArgs {
  paceMs: number;
  timeoutMs: number;
  alertWindow: string;
  huntTimespan: string;
  rowWidthSample: number;
  skipTableProbe: boolean;
  sections: Set<SectionId>;
  outDir?: string;
  /**
   * Arm section I's write half (PRD-10 Phase 2, AC5).
   *
   * Off by default and deliberately awkward to turn on. Every other request this script makes is a
   * read; a `PATCH` to `alerts_v2` adds a comment to a real analyst's real alert, and Microsoft
   * documents no way to delete one. The probe cannot clean up after itself, so the operator has to
   * say which alert they are willing to mark.
   */
  writeProbe: boolean;
  writeProbeAlertId?: string;
}

const KNOWN_FLAGS = new Set(["skip-table-probe", "write-probe"]);
const KNOWN_VALUES = new Set([
  "only",
  "out",
  "pace-ms",
  "timeout-ms",
  "alert-window",
  "hunt-timespan",
  "row-width-sample",
  "write-probe-alert",
]);

export function parseArgs(argv: readonly string[]): ProbeArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}". Every option is a --flag or --name value.`);
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(arg.slice(2));
      continue;
    }
    values.set(arg.slice(2), next);
    index += 1;
  }

  // A misspelled flag must not fail open. `--skip-table-probes` or `--skip-tables` would otherwise
  // be ignored in silence and spend 41 calls the operator asked not to spend; a mistyped
  // `--pace-ms` would silently restore the default pacing against a tenant someone chose to be
  // gentle with. Both are cheap to typo and expensive to discover afterwards.
  const unknown = [
    ...[...flags].filter((name) => !KNOWN_FLAGS.has(name)),
    ...[...values.keys()].filter((name) => !KNOWN_VALUES.has(name)),
  ];
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}. ` +
        `Known: ${[...KNOWN_FLAGS, ...KNOWN_VALUES]
          .toSorted()
          .map((name) => `--${name}`)
          .join(", ")}.`,
    );
  }

  const number = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive number, got "${raw}".`);
    }
    return parsed;
  };

  const only = values.get("only");
  const sections = new Set<SectionId>(SECTION_IDS);
  if (only !== undefined) {
    sections.clear();
    for (const raw of only.split(",")) {
      const id = raw.trim().toUpperCase();
      const known = SECTION_IDS.find((candidate) => candidate === id);
      if (known === undefined) {
        throw new Error(`--only: unknown section "${raw}". Known: ${SECTION_IDS.join(", ")}.`);
      }
      sections.add(known);
    }
  }

  const outDir = values.get("out");
  const alertWindow = values.get("alert-window") ?? "P7D";
  // Parsed here for its throw, not its value: a malformed duration must fail before the first
  // request rather than after section B has already spent a dozen calls.
  windowMs(alertWindow);

  return {
    // The documented floor is "at least 45 calls per minute per tenant"; 1,500 ms leaves headroom
    // under it without turning the sweep into a coffee break.
    paceMs: number("pace-ms", 1_500),
    // Longer than the connector's 30 s (D2's table): a hunting request may run for three minutes
    // before the service times it out, and observing that is one of the things §8 asks for.
    timeoutMs: number("timeout-ms", 60_000),
    alertWindow,
    huntTimespan: values.get("hunt-timespan") ?? "P7D",
    rowWidthSample: Math.floor(number("row-width-sample", 50)),
    skipTableProbe: flags.has("skip-table-probe"),
    writeProbe: flags.has("write-probe"),
    ...(values.get("write-probe-alert") === undefined
      ? {}
      : { writeProbeAlertId: values.get("write-probe-alert") as string }),
    sections,
    ...(outDir === undefined ? {} : { outDir }),
  };
}
interface ProbeCall {
  section: SectionId;
  id: string;
  /** What this call is here to answer, in the PRD's or the research note's own terms. */
  question: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  status: number;
  statusText: string;
  durationMs: number;
  responseHeaders: Record<string, string>;
  body?: unknown;
  /** Set when the request never got a response at all. */
  transportError?: string;
}

interface Finding {
  section: SectionId;
  /** The question this answers — a PRD-8 §7 `Qn`, or a research-note §8 item number. */
  question: string;
  answer: string;
  /** `unanswered` is a result too, and §5's exit criterion accepts it when it says why. */
  status: "answered" | "unanswered";
}

/** Response headers worth keeping. Everything else is transport noise. */
const KEPT_RESPONSE_HEADERS = [
  "retry-after",
  "content-type",
  "content-length",
  "request-id",
  "client-request-id",
  "x-ms-ags-diagnostic",
  "odata-version",
  "preference-applied",
] as const;

export class Recorder {
  readonly calls: ProbeCall[] = [];
  readonly findings: Finding[] = [];
  readonly notes: string[] = [];

  call(entry: ProbeCall): void {
    this.calls.push(entry);
  }

  answer(section: SectionId, question: string, answer: string): void {
    this.findings.push({ section, question, answer, status: "answered" });
  }

  unanswered(section: SectionId, question: string, why: string): void {
    this.findings.push({ section, question, answer: why, status: "unanswered" });
  }

  note(message: string): void {
    this.notes.push(message);
  }

  find(id: string): ProbeCall | undefined {
    return this.calls.find((entry) => entry.id === id);
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Two levels, because they protect against different things.
 *
 * `secrets` are removed from *everything* this script writes, including the raw transcript: an
 * ignored directory is not an access control, and a bearer token in a file is a bearer token.
 * `identifiers` are removed only from `findings.md`, which is the half meant to be copied into a
 * committed research note — the transcript keeps them because a probe you cannot correlate with the
 * tenant you ran it against is not evidence.
 */
interface Redactor {
  transcript: (value: string) => string;
  findings: (value: string) => string;
}

function createRedactor(
  secrets: readonly string[],
  identifiers: readonly (readonly [string, string])[],
): Redactor {
  const kept = secrets.filter((value) => value.length >= 8);
  const transcript = (value: string): string =>
    kept.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), value);

  return {
    transcript,
    findings: (value: string): string =>
      identifiers
        .filter(([actual]) => actual.length >= 8)
        .reduce((safe, [actual, label]) => safe.replaceAll(actual, label), transcript(value)),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface RequestSpec {
  section: SectionId;
  id: string;
  question: string;
  /**
   * `PATCH` exists for section I alone (PRD-10 Phase 2).
   *
   * This union was `"GET" | "POST"` for the whole of PRD-8, and that was the probe's read-only
   * guarantee stated where a compiler could hold it. Widening it is the real change here — every
   * other section still only reads, and section I's write half is gated behind an explicit flag
   * and an operator-named alert because a Graph alert comment cannot be deleted.
   */
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Body bytes to keep. Hunting results are trimmed by the caller, not here. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

/**
 * A 429 that the probe kept calling through would be the exact harm this file exists to avoid.
 *
 * Microsoft's guidance, quoted in `docs/research-defender-api.md` §7: "Avoid immediate retries,
 * because all requests accrue against your usage limits." Advanced hunting's 429 means the tenant's
 * shared CPU allowance is spent and every consumer is blocked until the next 15-minute cycle — so
 * the honest response is to stop, not to pace a little and continue.
 */
export class ThrottledError extends Error {
  override readonly name = "ThrottledError";
  readonly call: ProbeCall;

  constructor(call: ProbeCall) {
    const retryAfter = call.responseHeaders["retry-after"];
    super(
      `${call.id} returned 429${retryAfter === undefined ? " with no Retry-After" : `; Retry-After: ${retryAfter}`}. ` +
        "The tenant's hunting allowance is exhausted, so the run stopped rather than deepening it.",
    );
    this.call = call;
  }
}

export class Transport {
  readonly #recorder: Recorder;
  readonly #timeoutMs: number;
  readonly #paceMs: number;
  #lastCallAt = 0;
  /** Sticky. Once the tenant has said back off, no later section may quietly try again. */
  #throttled: ProbeCall | undefined;

  constructor(recorder: Recorder, timeoutMs: number, paceMs: number) {
    this.#recorder = recorder;
    this.#timeoutMs = timeoutMs;
    this.#paceMs = paceMs;
  }

  get throttled(): ProbeCall | undefined {
    return this.#throttled;
  }

  /** Serial by construction — see the file header for why this is not an optimisation to remove. */
  async send(spec: RequestSpec): Promise<ProbeCall> {
    if (this.#throttled !== undefined) throw new ThrottledError(this.#throttled);

    const call = await this.#dispatch(spec);

    // Recorded before the throw, deliberately: the `Retry-After` header on this response is the
    // only evidence §7 Q11 asks for, and losing it to the abort would waste the one 429 the probe
    // will ever legitimately see.
    if (call.status === 429) {
      this.#throttled = call;
      throw new ThrottledError(call);
    }
    return call;
  }

  async #dispatch(spec: RequestSpec): Promise<ProbeCall> {
    const wait = this.#lastCallAt + this.#paceMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.#lastCallAt = Date.now();

    const headers: Record<string, string> = { accept: "application/json", ...spec.headers };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(spec.body);
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(spec.url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const call: ProbeCall = {
        section: spec.section,
        id: spec.id,
        question: spec.question,
        method: spec.method,
        url: spec.url,
        requestHeaders: describeHeaders(headers),
        ...(spec.body === undefined ? {} : { requestBody: spec.body }),
        status: 0,
        statusText: "",
        durationMs: Date.now() - started,
        responseHeaders: {},
        transportError: error instanceof Error ? error.message : String(error),
      };
      this.#recorder.call(call);
      return call;
    }

    const text = await response.text();
    const durationMs = Date.now() - started;
    const limit = spec.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = { unparsedText: text.slice(0, limit) };
    }

    const call: ProbeCall = {
      section: spec.section,
      id: spec.id,
      question: spec.question,
      method: spec.method,
      url: spec.url,
      requestHeaders: describeHeaders(headers),
      ...(spec.body === undefined ? {} : { requestBody: spec.body }),
      status: response.status,
      statusText: response.statusText,
      durationMs,
      responseHeaders: keptHeaders(response.headers),
      ...(body === undefined ? {} : { body }),
    };
    this.#recorder.call(call);
    return call;
  }
}
function describeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      name.toLowerCase() === "authorization" ? "Bearer [redacted]" : value,
    ]),
  );
}

function keptHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Response readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The Graph error envelope, tolerating both spellings of the nested member.
 *
 * Microsoft's own page disagrees with itself: the JSON representation block and the property table
 * say `innererror`, while every concrete example on that page — and every observed runHuntingQuery
 * 400 — says `innerError`. A parser that picks one is wrong half the time (§4.2 "Error contract").
 */
function graphError(body: unknown): { code: string; message: string; inner?: string } | undefined {
  const error = asRecord(asRecord(body)?.["error"]);
  if (error === undefined) return undefined;
  const code = asString(error["code"]) ?? "";
  const message = asString(error["message"]) ?? "";
  const inner = asRecord(error["innerError"]) ?? asRecord(error["innererror"]);
  const innerCode = inner === undefined ? undefined : asString(inner["code"]);
  return { code, message, ...(innerCode === undefined ? {} : { inner: innerCode }) };
}

/** Which of the two spellings this response actually used. A design input, not trivia. */
function innerErrorKey(body: unknown): string | undefined {
  const error = asRecord(asRecord(body)?.["error"]);
  if (error === undefined) return undefined;
  if (asRecord(error["innerError"]) !== undefined) return "innerError";
  if (asRecord(error["innererror"]) !== undefined) return "innererror";
  return undefined;
}

interface HuntingResults {
  schema: { name: string; type: string }[];
  results: Record<string, unknown>[];
}

function huntingResults(body: unknown): HuntingResults | undefined {
  const record = asRecord(body);
  if (record === undefined) return undefined;
  const rawSchema = record["schema"];
  const rawResults = record["results"];
  if (!Array.isArray(rawSchema) || !Array.isArray(rawResults)) return undefined;

  const schema = rawSchema.flatMap((entry) => {
    const column = asRecord(entry);
    if (column === undefined) return [];
    const name = asString(column["name"]);
    if (name === undefined) return [];
    return [{ name, type: asString(column["type"]) ?? "" }];
  });
  const results = rawResults.flatMap((entry) => {
    const row = asRecord(entry);
    return row === undefined ? [] : [row];
  });
  return { schema, results };
}

function describeCall(call: ProbeCall): string {
  if (call.transportError !== undefined) return `transport failure — ${call.transportError}`;
  const error = graphError(call.body);
  if (error === undefined) return `HTTP ${call.status}`;
  return `HTTP ${call.status}, code \`${error.code}\` — ${error.message}`;
}

function ok(call: ProbeCall): boolean {
  return call.status >= 200 && call.status < 300;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index] ?? 0;
}

/** Empty arrays, empty strings, `null` and absent all count as unfilled — see §7 Q8. */
function populated(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : value !== undefined && value !== null && value !== "";
}

/** The per-source, labelled table block §4.2 specifies for turn-0 once several sources are active. */
function tableBlock(id: string, introduction: string, tables: readonly string[]): string {
  return [
    introduction,
    "",
    `<available_tables source="${id}">`,
    tables.join("\n"),
    "</available_tables>",
  ].join("\n");
}

/** A chars/4 estimate, not a tokeniser. Enough to answer "is this too large", which is §7 Q2. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function log(message: string): void {
  console.info(message);
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

/**
 * Where this run's artifacts go, refused if it is not under `.data/` (AC14).
 *
 * Exported and pure so `probe-defender.test.ts` can assert the refusal without a tenant, which is
 * the only way that half of AC14 is testable at all.
 */
export function probeOutputDir(stamp: string, override?: string): string {
  const directory = override ?? join(DATA_ROOT, "defender-probe", stamp);
  const fromDataRoot = relative(resolve(DATA_ROOT), resolve(directory));
  if (fromDataRoot.startsWith("..") || isAbsolute(fromDataRoot)) {
    throw new Error(
      `The Defender probe reads a live tenant, so its output must stay inside ${DATA_ROOT}/; ` +
        `${directory} is outside it (PRD-8 §4.1 D10).`,
    );
  }
  return directory;
}

/** Filesystem-safe, sorts chronologically, and carries no tenant identifier. */
export function probeStamp(now: Date): string {
  return now.toISOString().replaceAll(/[:.]/g, "-").replace("Z", "");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Context {
  args: ProbeArgs;
  recorder: Recorder;
  transport: Transport;
  token: string;
  tenantId: string;
  workspaceId?: string;
}

function authHeaders(context: Context, prefer?: string): Record<string, string> {
  return {
    authorization: `Bearer ${context.token}`,
    ...(prefer === undefined ? {} : { prefer }),
  };
}

function alertsUrl(query?: string): string {
  return query === undefined
    ? `${GRAPH}/security/alerts_v2`
    : `${GRAPH}/security/alerts_v2?${query}`;
}

async function hunt(
  context: Context,
  id: string,
  question: string,
  query: string,
  extra: { timespan?: string; workspaceId?: string } = {},
): Promise<ProbeCall> {
  const timespan = extra.timespan ?? context.args.huntTimespan;
  return context.transport.send({
    section: id.charAt(0) as SectionId,
    id,
    question,
    method: "POST",
    url: `${GRAPH}/security/runHuntingQuery`,
    headers: authHeaders(context),
    body: {
      Query: query,
      Timespan: timespan,
      ...(extra.workspaceId === undefined ? {} : { workspaceId: extra.workspaceId }),
    },
  });
}

/**
 * Section B — `alerts_v2`: parameters, ordering, the Prefer header, and what a mapped alert holds.
 *
 * Answers §7 Q4 and Q8, the D14 newest-first observation, and research-note §8 items 1–3, 5–7, 9,
 * 11 and 15. Returns the window sample so section H can size turn-0 context without re-fetching it.
 */
/**
 * Section B — `alerts_v2`: parameters, ordering, the Prefer header, and what a mapped alert holds.
 *
 * Answers §7 Q4 and Q8, the D14 newest-first observation, and research-note §8 items 1-3, 5-7, 9,
 * 11 and 15. Returns the window sample so section H can size turn-0 context without re-fetching it.
 *
 * Almost every finding here is conditioned on the tenant holding enough alerts to distinguish the
 * question from an artefact of its own size. On a tenant with one alert, "default page size 1" and
 * "$top=1000 honoured" are the same sentence as "there is one alert", and writing either as an
 * answer would put a false claim into a document a design decision gets locked against.
 */
async function sectionB(context: Context): Promise<Record<string, unknown>[]> {
  const { recorder } = context;
  log("[probe] B — alerts_v2 parameters, ordering and field population");

  const withPrefer = await context.transport.send({
    section: "B",
    id: "B1",
    question: "Baseline alerts_v2 shape with Prefer: include-unknown-enum-members",
    method: "GET",
    url: alertsUrl("$top=1"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  const withoutPrefer = await context.transport.send({
    section: "B",
    id: "B2",
    question: "§8 #15 — do evolvable enum members collapse without the Prefer header?",
    method: "GET",
    url: alertsUrl("$top=1"),
    headers: authHeaders(context),
  });

  preferHeaderFinding(recorder, withPrefer, withoutPrefer);

  const noParams = await context.transport.send({
    section: "B",
    id: "B3",
    question: "§8 #2, #9 — default page size, and whether nextLink carries $skip or $skiptoken",
    method: "GET",
    url: alertsUrl(),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });
  // Held until B6 supplies the tenant's alert total. A page size is only a page size when more
  // alerts were available than came back; below that it is the tenant's alert count wearing a
  // page size's name.
  const unpagedBody = ok(noParams) ? asRecord(noParams.body) : undefined;
  const unpagedValue = unpagedBody?.["value"];
  const unpagedCount = Array.isArray(unpagedValue) ? unpagedValue.length : 0;
  const unpagedNext = asString(unpagedBody?.["@odata.nextLink"]);
  const pagingToken =
    unpagedNext === undefined
      ? "no `@odata.nextLink` on page 1"
      : unpagedNext.includes("$skiptoken")
        ? "`@odata.nextLink` carries `$skiptoken`"
        : unpagedNext.includes("$skip")
          ? "`@odata.nextLink` carries `$skip`"
          : "`@odata.nextLink` present, carrying neither `$skip` nor `$skiptoken` literally";

  const orderBy = await context.transport.send({
    section: "B",
    id: "B4",
    question: "§8 #3 — is $orderby accepted, rejected, or silently ignored? (D14 rests on this)",
    method: "GET",
    url: alertsUrl("$top=5&$orderby=createdDateTime%20desc"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  const bigTop = await context.transport.send({
    section: "B",
    id: "B5",
    question: "§8 #1 — is $top honoured, clamped, or rejected above the documented range?",
    method: "GET",
    url: alertsUrl("$top=1000"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });
  const bigTopValue = ok(bigTop) ? asRecord(bigTop.body)?.["value"] : undefined;
  const bigTopReturned = Array.isArray(bigTopValue) ? bigTopValue.length : 0;

  const count = await context.transport.send({
    section: "B",
    id: "B6",
    question: "§8 #7 — does $count=true return @odata.count?",
    method: "GET",
    url: alertsUrl("$count=true&$top=1"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });
  const rawCount = ok(count) ? asRecord(count.body)?.["@odata.count"] : undefined;
  const total = typeof rawCount === "number" ? rawCount : undefined;

  recorder.answer(
    "B",
    "§8 #7 — $count=true",
    ok(count)
      ? total === undefined
        ? "Accepted, but no `@odata.count` in the body — the parameter is tolerated and ignored."
        : `Supported: \`@odata.count\` = ${total} alert(s) in the tenant. This is the number every other finding in this section has to be read against.`
      : `Rejected — ${describeCall(count)}.`,
  );

  if (ok(noParams)) {
    recorder.answer(
      "B",
      "§8 #2, #9 — default page size and paging token",
      total !== undefined && total <= unpagedCount
        ? `**Not measurable on this tenant.** A parameterless GET returned ${unpagedCount} item(s), which is every alert it holds (\`@odata.count\` = ${total}). That is the alert count, not a page size, and nothing here says what the server would do with more. ${pagingToken}.`
        : `A parameterless GET returned ${unpagedCount} item(s) out of ${total ?? "an unknown"} total, so the default page size is ${unpagedCount}. ${pagingToken}.`,
    );
  } else {
    recorder.unanswered(
      "B",
      "§8 #2, #9 — default page size and paging token",
      describeCall(noParams),
    );
  }

  recorder.answer(
    "B",
    "§8 #1 — $top=1000",
    ok(bigTop)
      ? total !== undefined && total <= bigTopReturned
        ? `Accepted (HTTP ${bigTop.status}), and **the ceiling is untested**: ${bigTopReturned} item(s) came back because that is every alert the tenant holds (\`@odata.count\` = ${total}). A tenant with fewer alerts than the requested \`$top\` cannot distinguish "honoured" from "clamped" from "ignored".`
        : `Accepted (HTTP ${bigTop.status}), ${bigTopReturned} item(s) returned out of ${total ?? "an unknown"} total — so \`$top=1000\` is honoured rather than clamped to a smaller page.`
      : `Rejected — ${describeCall(bigTop)}.`,
  );

  const select = await context.transport.send({
    section: "B",
    id: "B7",
    question: "§8 #5 — is $select accepted on alerts_v2?",
    method: "GET",
    url: alertsUrl("$top=1&$select=id,severity,createdDateTime"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });
  recorder.answer(
    "B",
    "§8 #5 — $select",
    ok(select) ? `Accepted with HTTP ${select.status}.` : `Rejected — ${describeCall(select)}.`,
  );

  // D14's actual mechanism: a server-side window on createdDateTime, which is one of the eight
  // filterable properties and one of only two that bound recency. `$count=true` rides along so the
  // cap question is judged against the window's real total rather than against our own `$top`.
  const since = new Date(Date.now() - windowMs(context.args.alertWindow)).toISOString();
  const windowed = await context.transport.send({
    section: "B",
    id: "B8",
    question: `D14 — a createdDateTime window (${context.args.alertWindow}), and whether the service happens to return newest-first`,
    method: "GET",
    // 501, not 500, and for the same reason `azure.ts` sends `take 501`: a request capped at the
    // cap can never observe the cap being exceeded.
    url: alertsUrl(
      `$count=true&$filter=createdDateTime%20ge%20${encodeURIComponent(since)}&$top=501`,
    ),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  const sample: Record<string, unknown>[] = [];
  if (ok(windowed)) {
    const body = asRecord(windowed.body);
    const value = body?.["value"];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const alert = asRecord(entry);
        if (alert !== undefined) sample.push(alert);
      }
    }
    const rawWindowCount = body?.["@odata.count"];
    const windowTotal = typeof rawWindowCount === "number" ? rawWindowCount : undefined;

    recorder.answer(
      "B",
      "D14 — the createdDateTime window",
      `\`$filter=createdDateTime ge <iso>\` accepted; ${sample.length} alert(s) returned for the last ${context.args.alertWindow}${windowTotal === undefined ? "" : `, \`@odata.count\` = ${windowTotal}`}. Filtering on \`createdDateTime\` is what makes D14's window expressible at all.`,
    );

    // Ordering needs at least two alerts to be an observation rather than a formality.
    const created = sample.map((alert) => asString(alert["createdDateTime"]) ?? "");
    if (created.length < 2) {
      recorder.unanswered(
        "B",
        "D14 — does the service happen to return newest-first?",
        `Only ${created.length} alert(s) came back, so there was no order to observe. This is the observation D14 explicitly declines to design on, so an empty result costs nothing — but it must not be recorded as a confirmed ordering.`,
      );
    } else {
      const descending = created.every(
        (createdAt, index) => index === 0 || (created[index - 1] ?? "") >= createdAt,
      );
      recorder.answer(
        "B",
        "D14 — does the service happen to return newest-first?",
        `Over ${created.length} alert(s) the returned order is ${descending ? "newest-first" : "**not** newest-first"}. An observation only — the supported-parameter list does not promise it, which is why D14 bounds by window rather than by position. ${
          ok(orderBy)
            ? `\`$orderby\` was accepted at B4 with HTTP ${orderBy.status}; this run ${descending ? "cannot separate an honoured sort from an ignored one, because B8 sends no `$orderby` at all and still came back ordered" : "shows the service returning unordered results, so an accepted `$orderby` is being ignored"}.`
            : ""
        }`,
      );
    }

    const cap = windowTotal ?? sample.length;
    recorder.answer(
      "B",
      "§7 Q6 residue — is D14's fail-loud cap reachable on this tenant?",
      cap > 500
        ? `Yes: ${cap} alert(s) in ${context.args.alertWindow}, above D14's cap of 500. An operator meets the refusal on the first run.`
        : `Not on this window: ${cap} alert(s) in ${context.args.alertWindow}, under the cap of 500. The request asked for 501 so exceeding the cap would be visible if it happened; it did not.`,
    );
  } else {
    recorder.unanswered("B", "D14 — the createdDateTime window", describeCall(windowed));
  }

  const first = sample[0] ?? asFirstAlert(withPrefer);
  const firstId = first === undefined ? undefined : asString(first["id"]);
  if (firstId !== undefined) {
    const byId = await context.transport.send({
      section: "B",
      id: "B9",
      question: "Round-trip: does GET /security/alerts_v2/{id} return the same alert?",
      method: "GET",
      url: `${GRAPH}/security/alerts_v2/${encodeURIComponent(firstId)}`,
      headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
    });
    // A 200 says the route exists. Only the id says it is the same alert.
    const returnedId = ok(byId) ? asString(asRecord(byId.body)?.["id"]) : undefined;
    recorder.answer(
      "B",
      "Alert round-trip",
      !ok(byId)
        ? describeCall(byId)
        : returnedId === firstId
          ? `\`GET /security/alerts_v2/{id}\` returned the alert whose \`id\` was requested (HTTP ${byId.status}), so the list id and the item id address the same thing — which is what \`getAlert()\` will depend on.`
          : `HTTP ${byId.status}, but the returned \`id\` ${returnedId === undefined ? "is absent" : "differs from the one requested"}. Phase 1's \`getAlert()\` cannot assume the list id addresses the item.`,
    );

    const missing = await context.transport.send({
      section: "B",
      id: "B10",
      question: "§8 #11 — what does an unknown alert id return?",
      method: "GET",
      url: `${GRAPH}/security/alerts_v2/${encodeURIComponent("da000000-0000-0000-0000-00000000dead")}`,
      headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
    });
    recorder.answer("B", "§8 #11 — unknown alert id", describeCall(missing));
  } else {
    recorder.unanswered(
      "B",
      "Alert round-trip and §8 #11",
      "No alert was returned, so there was no id to round-trip. A tenant with no alerts in the window cannot answer this.",
    );
  }

  analyseAlerts(context, sample);
  return sample;
}

/**
 * §8 #15 — the Prefer header, compared only where a comparison exists.
 *
 * B1 and B2 are two independent `$top=1` requests with no `$orderby`, so nothing guarantees they
 * returned the same alert. Comparing the enum values of two different alerts and reporting "no
 * observable difference" would be a claim about the header drawn from a difference in the data.
 */
function preferHeaderFinding(
  recorder: Recorder,
  withPrefer: ProbeCall,
  withoutPrefer: ProbeCall,
): void {
  if (!ok(withPrefer) || !ok(withoutPrefer)) {
    recorder.unanswered(
      "B",
      "§8 #15 — Prefer: include-unknown-enum-members",
      `alerts_v2 did not return a comparable pair — with header: ${describeCall(withPrefer)}; without: ${describeCall(withoutPrefer)}.`,
    );
    return;
  }

  const alertOf = (call: ProbeCall): Record<string, unknown> | undefined => asFirstAlert(call);
  const a = alertOf(withPrefer);
  const b = alertOf(withoutPrefer);
  const enums = (alert: Record<string, unknown> | undefined): string =>
    [
      asString(alert?.["serviceSource"]) ?? "absent",
      asString(alert?.["detectionSource"]) ?? "absent",
    ].join(" / ");

  if (a === undefined || b === undefined) {
    recorder.unanswered(
      "B",
      "§8 #15 — Prefer: include-unknown-enum-members",
      'One or both requests returned no alert, so there was nothing to compare. The header is mandatory on documented grounds regardless (§4.2 "Listing alerts").',
    );
    return;
  }

  const sameAlert = asString(a["id"]) === asString(b["id"]);
  const applied = withPrefer.responseHeaders["preference-applied"];
  if (applied !== undefined) {
    recorder.note(`\`Preference-Applied: ${applied}\` came back on B1.`);
  }

  if (!sameAlert) {
    recorder.unanswered(
      "B",
      "§8 #15 — Prefer: include-unknown-enum-members",
      `The two \`$top=1\` requests returned **different alerts**, and \`alerts_v2\` supports no \`$orderby\` to pin which one comes back — so any difference in \`serviceSource\`/\`detectionSource\` between them is a difference in the data, not in the header. Keep sending the header: the documented collapse of twenty-one members, including \`microsoftSentinel\`, is reason enough without this run (§4.2).`,
    );
    return;
  }

  const withValue = enums(a);
  const withoutValue = enums(b);
  recorder.answer(
    "B",
    "§8 #15 — Prefer: include-unknown-enum-members",
    withValue === withoutValue
      ? `Same alert both times; \`serviceSource\`/\`detectionSource\` is \`${withValue}\` with and without the header. **This does not clear the header** — the documented collapse applies to the post-\`unknownFutureValue\` members, and \`${withValue}\` is not one of them, so this sample could not have shown a difference. Keep sending it.`
      : `Same alert, different wire values: \`${withValue}\` with the header, \`${withoutValue}\` without. The collapse is real and observed here, so sending the header is mandatory (§4.2 "Listing alerts").`,
  );
}
function asFirstAlert(call: ProbeCall): Record<string, unknown> | undefined {
  const value = asRecord(call.body)?.["value"];
  return Array.isArray(value) ? asRecord(value[0]) : undefined;
}

/** ISO 8601 durations this probe actually accepts, kept deliberately small. */
function windowMs(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration);
  if (match === null) {
    throw new Error(
      `--alert-window must be an ISO 8601 duration such as P7D or PT12H, got "${duration}".`,
    );
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const total = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (total <= 0) throw new Error(`--alert-window must be a positive duration, got "${duration}".`);
  return total;
}

/** §7 Q4 (is `detectorId` the honest `alertType`?) and §7 Q8 (does an alert fill `AlertContext`?). */
/** §7 Q4 (is `detectorId` the honest `alertType`?) and §7 Q8 (does an alert fill `AlertContext`?). */
function analyseAlerts(context: Context, alerts: readonly Record<string, unknown>[]): void {
  const { recorder } = context;
  if (alerts.length === 0) {
    recorder.unanswered(
      "B",
      "§7 Q4 — is `detectorId` the honest `alertType`? / §7 Q8 — does a Defender alert fill `AlertContext`?",
      `No alerts within ${context.args.alertWindow}, so neither the mapping nor the fill rate could be measured. Re-run with a wider \`--alert-window\`.`,
    );
    return;
  }

  // §4.2's mapping table, as the connector will read it.
  const mapped: readonly (readonly [string, string])[] = [
    ["severity", "severity"],
    ["status", "status"],
    ["alertType", "detectorId"],
    ["startTimeUtc", "firstActivityDateTime"],
    ["endTimeUtc", "lastActivityDateTime"],
    ["timeGenerated", "createdDateTime"],
    ["tactics", "categories"],
    ["techniques", "mitreTechniques"],
    ["entities", "evidence"],
  ];

  const rates = mapped.map(([common, graph]) => {
    const filled = alerts.filter((alert) => populated(alert[graph])).length;
    return `\`${common}\` ← \`${graph}\`: ${filled}/${alerts.length}`;
  });
  const incidentIds = alerts.filter((alert) => populated(alert["incidentId"])).length;

  recorder.answer(
    "B",
    "§7 Q8 — does a Defender alert fill `AlertContext`?",
    [
      `Over ${alerts.length} alert(s) in the last ${context.args.alertWindow}:`,
      ...rates.map((line) => `  - ${line}`),
      `  - \`compromisedEntity\`: 0/${alerts.length} by construction — Graph has no such field and §4.2 leaves it \`undefined\` rather than deriving one from \`evidence\`.`,
      `  - \`incidentId\` present on ${incidentIds}/${alerts.length}, carried through on \`native\` (§4.2).`,
      "A low `categories` rate means the artifact's `tactics` is legitimately empty, which the contract allows and §4.2 forbids filling from another field.",
      alerts.length < 5
        ? `**Sample size ${alerts.length}.** A fill rate over this few alerts describes these alerts, not the product. Widen \`--alert-window\` before treating any of the above as a rate.`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  // Q4: is `detectorId` per-detection-logic, or per-instance? The test only exists where a group
  // holds more than one alert. Grouping singletons and observing that each group has one distinct
  // value proves nothing — it is a tautology, and reporting it as stability would close a `[I]`
  // claim on no evidence.
  const groups = new Map<string, Set<string>>();
  for (const alert of alerts) {
    const key = [asString(alert["title"]) ?? "", asString(alert["detectionSource"]) ?? ""].join(
      "|",
    );
    const detector = asString(alert["detectorId"]) ?? "(absent)";
    const seen = groups.get(key) ?? new Set<string>();
    seen.add(detector);
    groups.set(key, seen);
  }
  const sizes = new Map<string, number>();
  for (const alert of alerts) {
    const key = [asString(alert["title"]) ?? "", asString(alert["detectionSource"]) ?? ""].join(
      "|",
    );
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const testable = [...sizes.entries()].filter(([, size]) => size > 1);
  const varying = [...groups.entries()].filter(
    ([key, detectors]) => detectors.size > 1 && (sizes.get(key) ?? 0) > 1,
  ).length;
  const absent = alerts.filter((alert) => asString(alert["detectorId"]) === undefined).length;

  const preamble = `\`detectorId\` absent on ${absent}/${alerts.length} alert(s). Grouped by (\`title\`, \`detectionSource\`) — a proxy for detection logic — ${groups.size} group(s) over ${alerts.length} alert(s).`;

  if (testable.length === 0) {
    recorder.unanswered(
      "B",
      "§7 Q4 — is `detectorId` the honest `alertType`?",
      `${preamble} **Every group holds exactly one alert, so stability was not tested at all** — a set of one value is trivially of size one, whatever the field means. §4.2's mapping stays \`[I]\` on this run. Re-run with a wider \`--alert-window\`, or against a tenant where one detection has fired more than once.`,
    );
  } else {
    recorder.answer(
      "B",
      "§7 Q4 — is `detectorId` the honest `alertType`?",
      `${preamble} ${testable.length} group(s) hold more than one alert and are therefore the only ones that test anything; ${varying} of those carry more than one \`detectorId\`. ${
        varying === 0
          ? "Constant within every testable group, which is what §4.2's mapping assumes. Still `[I]`: this shows stability on this sample, not that Microsoft intends it as the detection identifier."
          : "**Varies within a group**, so `detectorId` is at least partly per-instance here. §4.2 says the field is left `undefined` rather than mapped if this cannot be confirmed — this is the evidence for that branch."
      }`,
    );
  }

  const serviceSources = new Map<string, number>();
  for (const alert of alerts) {
    const value = asString(alert["serviceSource"]) ?? "(absent)";
    serviceSources.set(value, (serviceSources.get(value) ?? 0) + 1);
  }
  recorder.answer(
    "B",
    "§7 Q9 corroboration — which products' detections reach `alerts_v2`?",
    [...serviceSources.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .map(([value, seen]) => `\`${value}\` ×${seen}`)
      .join(", ") +
      ". A `microsoftSentinel` entry here would contradict §7 Q9's desk finding that this tenant's workspace is not onboarded.",
  );
}
async function sectionC(context: Context): Promise<string[]> {
  const { recorder } = context;
  log("[probe] C — schema discovery (§7 Q1, mechanisms 1–3)");

  const getschema = await hunt(
    context,
    "C1",
    "§8 #38 — mechanism 1: is `getschema` accepted by advanced hunting?",
    "AlertInfo | getschema",
  );
  const getschemaWorks = ok(getschema);
  recorder.answer(
    "C",
    "§7 Q1 mechanism 1 — per-table `getschema`",
    getschemaWorks
      ? `Accepted (HTTP ${getschema.status}). Undocumented for this surface but functional. Exact if used, and pays one call per candidate table against a 45/minute budget on every process start.`
      : `Rejected — ${describeCall(getschema)}.`,
  );

  const fuzzy = await hunt(
    context,
    "C2",
    "§8 #39 — mechanism 2: does `union isfuzzy=true` tolerate a missing table?",
    `union isfuzzy=true AlertInfo, ${CANARY_TABLE} | take 1`,
  );
  const strict = await hunt(
    context,
    "C3",
    "§8 #39 control — the same union without `isfuzzy`",
    `union AlertInfo, ${CANARY_TABLE} | take 1`,
  );
  const fuzzyTolerates = ok(fuzzy) && !ok(strict);
  recorder.answer(
    "C",
    "§7 Q1 mechanism 2 — one batched `union isfuzzy=true`",
    fuzzyTolerates
      ? `Tolerant: with \`isfuzzy=true\` the missing table is absorbed (HTTP ${fuzzy.status}); without it the same union fails — ${describeCall(strict)}. This is the only mechanism that scales, and it is now measured rather than assumed.`
      : ok(fuzzy) && ok(strict)
        ? `Inconclusive: **both** forms returned HTTP ${fuzzy.status}, so the canary table did not fail the strict union either. The control is not discriminating and neither result can be trusted — re-run with a canary this tenant certainly lacks.`
        : fuzzy.status === 400
          ? `Not tolerant — \`isfuzzy=true\` still failed on the missing table: ${describeCall(fuzzy)}. Mechanism 2 is out, which is the outcome §4.2 expected and the reason the pinned manifest is the expected landing place.`
          : `**Undetermined.** The \`isfuzzy=true\` call did not fail on the query — ${describeCall(fuzzy)} — so this says nothing about whether the operator tolerates a missing table. A throttle, a timeout or an authorization failure is not a verdict on \`isfuzzy\`; re-run before reading mechanism 2 as ruled out.`,
  );

  if (getschemaWorks && fuzzyTolerates) {
    const batched = await hunt(
      context,
      "C4",
      "§7 Q1 — do mechanisms 1 and 2 compose into one call for the whole schema?",
      `union isfuzzy=true (AlertInfo | getschema | extend ProbeTable = "AlertInfo"), (AlertEvidence | getschema | extend ProbeTable = "AlertEvidence"), (${CANARY_TABLE} | getschema | extend ProbeTable = "${CANARY_TABLE}") | project ProbeTable, ColumnName, ColumnType`,
    );

    // "Composes" is a claim about a *batch*, so it needs more than a 200. A union whose legs all
    // dissolved returns 200 with no rows; a union where only one leg survived returns rows from
    // one table. Either would read as "the whole schema in a single request" while proving the
    // opposite, and this finding is the one that decides whether §4.2's fourth mechanism — the
    // vendored, pinned manifest — is needed at all.
    const rows = ok(batched) ? (huntingResults(batched.body)?.results ?? []) : [];
    const contributors = new Set(
      rows.flatMap((row) => {
        const table = asString(row["ProbeTable"]);
        return table === undefined ? [] : [table];
      }),
    );
    const canaryRows = contributors.has(CANARY_TABLE);
    const realTables = [...contributors].filter((table) => table !== CANARY_TABLE);

    recorder.answer(
      "C",
      "§7 Q1 — batched `union isfuzzy=true` over `getschema`",
      !ok(batched)
        ? `Does not compose — ${describeCall(batched)}. The two mechanisms work separately but not together, so the schema still costs one call per table.`
        : rows.length === 0
          ? `**Undetermined.** The call returned HTTP ${batched.status} with no rows, so every leg dissolved and nothing was measured. A 200 here is not evidence of composition.`
          : realTables.length >= 2 && !canaryRows
            ? `Composes: one call returned ${rows.length} column row(s) from ${realTables.length} distinct table(s) (${realTables.join(", ")}) while absorbing the canary. That is the whole schema in a single request, and it removes the need for §4.2's fourth mechanism — the vendored, pinned manifest — which was the expected landing place.`
            : canaryRows
              ? `**Suspect**: the result carries rows tagged \`${CANARY_TABLE}\`, a table that does not exist. The canary did not dissolve, so this batch is not demonstrating \`isfuzzy\` tolerance and the row count means something else.`
              : `Partial: ${rows.length} row(s) came back but from only ${realTables.length} table(s) (${realTables.join(", ") || "none identifiable"}). Composition across *several* tables is what makes this mechanism worth having, and one surviving leg does not show it — most likely the other named table is absent from this tenant and was absorbed along with the canary. Re-read against the table sweep below.`,
    );
  } else {
    recorder.note(
      "C4 (batched `union isfuzzy=true` over `getschema`) was not attempted: it composes two mechanisms and at least one of them failed on its own.",
    );
  }

  // Two legs prove the operator tolerates a missing table. They do not prove the *batch* Phase 1
  // will actually send: `getSchema()` unions every candidate table at once, and "Query size
  // exceeded" is a documented failure mode for wide unions — `The query cannot run because it
  // exceeds the allowed size limit when processed.` A decision to drop §4.2's vendored manifest
  // rests on the full-width query working, so the full-width query is the one that gets sent.
  if (getschemaWorks && fuzzyTolerates) {
    const legs = CANDIDATE_TABLES.map(
      (table) => `(${table} | getschema | extend ProbeTable = "${table}")`,
    ).join(", ");
    const full = await hunt(
      context,
      "C4b",
      `§7 Q1 — does the batch scale to all ${CANDIDATE_TABLES.length} candidates, or hit the query-size limit?`,
      `union isfuzzy=true ${legs} | project ProbeTable, ColumnName, ColumnType`,
    );
    const fullRows = ok(full) ? (huntingResults(full.body)?.results ?? []) : [];
    const fullTables = new Set(
      fullRows.flatMap((row) => {
        const table = asString(row["ProbeTable"]);
        return table === undefined ? [] : [table];
      }),
    );
    recorder.answer(
      "C",
      `§7 Q1 — does one batched call scale to the whole candidate list (${CANDIDATE_TABLES.length} legs)?`,
      !ok(full)
        ? `**No** — ${describeCall(full)}. A ${CANDIDATE_TABLES.length}-leg union does not survive, so whatever the two-leg case showed, Phase 1 cannot discover the schema in one request. Either chunk the union or fall back to §4.2's fourth mechanism.`
        : fullRows.length === 0
          ? `**Undetermined**: HTTP ${full.status} with no rows. A ${CANDIDATE_TABLES.length}-leg union that returns nothing has not demonstrated anything.`
          : `Yes: one ${CANDIDATE_TABLES.length}-leg call returned ${fullRows.length} column row(s) across ${fullTables.size} table(s) — the query text is ${legs.length.toLocaleString("en-US")} characters and did not hit the documented "Query size exceeded" limit. This is the query Phase 1's \`getSchema()\` would actually send, so the two-leg result above extrapolates rather than being extrapolated from.`,
    );
  }

  const control = await hunt(
    context,
    "C5",
    "§8 #41 — are Kusto control commands rejected, and with what message?",
    ".show tables",
  );
  recorder.answer(
    "C",
    "§8 #41 — control commands",
    ok(control)
      ? `**Accepted** (HTTP ${control.status}). That would be an enumeration path where the documentation says none exists — verify before relying on it, and note that the Phase 1 connector still refuses control commands the way \`azure.ts\` does.`
      : `Rejected — ${describeCall(control)}. Consistent with the Phase 1 connector refusing them locally rather than paying a round trip.`,
  );

  // Mechanism 3 is the one that produces the tenant's actual table set, which §7 Q2 also needs.
  if (context.args.skipTableProbe) {
    recorder.unanswered(
      "C",
      "§7 Q1 mechanism 3 — probe by error",
      "Skipped: --skip-table-probe was passed. No tenant table set was measured, so §7 Q2's combined context size is unmeasured too.",
    );
    return [];
  }

  const canary = await hunt(
    context,
    "C6",
    "Mechanism 3 control — a table this tenant certainly lacks must read as absent",
    `${CANARY_TABLE} | take 0`,
  );
  // The control has to return the *specific* status the sweep classifies on, not merely fail. A
  // 429, a client-side timeout, a 500 or a 403 all "fail" — and under any of them all 41 sweep
  // calls fail identically, so nothing resolves, `tables` comes back empty, and findings.md would
  // report "0 of 41 candidate tables resolve" as a fact about the tenant rather than about the
  // probe's own broken control.
  if (canary.status !== 400) {
    recorder.unanswered(
      "C",
      "§7 Q1 mechanism 3 — probe by error",
      `The control did not return a 400: \`${CANARY_TABLE} | take 0\` → ${describeCall(canary)}. Only a 400 makes "absent" distinguishable from a permission failure, a throttle or a transport fault, so the sweep could not discriminate and was not run. Nothing below would have been evidence.`,
    );
    return [];
  }
  recorder.answer(
    "C",
    "§7 Q1 mechanism 3 — probe by error, control",
    `\`${CANARY_TABLE} | take 0\` → ${describeCall(canary)}. An unresolvable table is a 400 and not a 403, which is what makes a missing table distinguishable from a permission failure and mechanism 3 viable at all.`,
  );

  log(
    `[probe] C — sweeping ${CANDIDATE_TABLES.length} candidate tables at ${context.args.paceMs} ms apart`,
  );
  const present: string[] = [];
  const absent: string[] = [];
  const inconclusive: string[] = [];
  let schemaOnZeroRows: { table: string; columns: number } | undefined;

  for (const [index, table] of CANDIDATE_TABLES.entries()) {
    const call = await hunt(
      context,
      `C7.${String(index + 1).padStart(2, "0")}`,
      `Mechanism 3 — does this tenant hold ${table}?`,
      `${table} | take 0`,
    );
    if (ok(call)) {
      present.push(table);
      const parsed = huntingResults(call.body);
      if (schemaOnZeroRows === undefined && parsed !== undefined && parsed.schema.length > 0) {
        schemaOnZeroRows = { table, columns: parsed.schema.length };
      }
    } else if (call.status === 400) {
      absent.push(table);
    } else {
      inconclusive.push(`${table} (${describeCall(call)})`);
    }
  }

  recorder.answer(
    "C",
    "§7 Q1 — the tenant's table set",
    [
      `${present.length} of ${CANDIDATE_TABLES.length} candidate tables resolve; ${absent.length} return 400 (absent or unlicensed); ${inconclusive.length} were inconclusive.`,
      `Present: ${present.join(", ") || "(none)"}`,
      `Absent: ${absent.join(", ") || "(none)"}`,
      inconclusive.length === 0 ? "" : `Inconclusive: ${inconclusive.join("; ")}`,
      "This is a candidate list filtered by the tenant, not an enumeration — §4.2's point is that no enumeration exists.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  if (schemaOnZeroRows !== undefined) {
    recorder.answer(
      "C",
      "§7 Q1 — does a zero-row result still carry `schema`?",
      `Yes: \`${schemaOnZeroRows.table} | take 0\` returned ${schemaOnZeroRows.columns} column definition(s) with no rows. That collapses mechanisms 1 and 3 into one — the same call that proves a table exists also returns its columns — and is the cheapest correct discovery path measured here, whatever \`getschema\` did.`,
    );
  } else if (present.length > 0) {
    recorder.answer(
      "C",
      "§7 Q1 — does a zero-row result still carry `schema`?",
      "No: a `| take 0` result carried no `schema`, so mechanism 3 establishes existence only and columns still cost a second call per table.",
    );
  }

  return present;
}

/** Section D — result-key casing (§7 Q3) and the positional projection D4 depends on. */
/** Section D — result-key casing (§7 Q3) and the positional projection D4 depends on. */
async function sectionD(context: Context, tables: readonly string[]): Promise<void> {
  const { recorder } = context;
  log("[probe] D — result-key casing and the positional projection");

  // `print` needs no table and is guaranteed to return exactly one row, so the casing question is
  // answerable even in a tenant whose hunting tables are empty.
  const printed = await hunt(
    context,
    "D1",
    "§7 Q3 — result-key casing, measured against column names this probe chose",
    'print ProbeMixedCaseOne = 1, probeMixedCaseTwo = "two"',
  );
  if (ok(printed)) {
    const parsed = huntingResults(printed.body);
    const row = parsed?.results[0];
    if (parsed !== undefined && row !== undefined) {
      const names = parsed.schema.map((column) => column.name);
      const keys = Object.keys(row);
      const exact = names.every((name) => Object.hasOwn(row, name));
      const insensitive = names.every((name) =>
        keys.some((key) => key.toLowerCase() === name.toLowerCase()),
      );
      // Keys the row carries that `schema` never named. OData annotations (`Foo@odata.type`) land
      // here, and they are exactly why D4 forbids taking column order from `Object.keys()`.
      const extra = keys.filter((key) => !names.includes(key));
      recorder.answer(
        "D",
        "§7 Q3 — the actual casing of `runHuntingQuery` result keys",
        [
          `\`schema\` names: ${names.map((name) => `\`${name}\``).join(", ")}.`,
          `\`results[0]\` keys: ${keys.map((key) => `\`${key}\``).join(", ")}.`,
          exact
            ? "Keys match `schema` names **exactly**, so D4's projection can index by name directly."
            : insensitive
              ? "Keys match only **case-insensitively** — the service re-cased them. D4's projection must fold case, and `DeviceProcessEvents` is where that bites: it holds both `LogonId` and `LogonID`, so a case-insensitive map collides and must fall back to the exact name when one exists."
              : "Keys match `schema` names neither exactly nor case-insensitively. D4's `null`-for-a-missing-key rule is doing real work, and the projection must not assume any relationship beyond position in `schema`.",
          extra.length === 0
            ? ""
            : `The row also carries ${extra.length} key(s) \`schema\` never named: ${extra.map((key) => `\`${key}\``).join(", ")}. These are OData annotations, and they are **concrete evidence for D4's rule that column order comes from \`schema\` and never from \`Object.keys()\`** — a projection built from the row's own keys would emit phantom columns.`,
        ]
          .filter((part) => part !== "")
          .join(" "),
      );
    } else {
      recorder.unanswered("D", "§7 Q3 — result-key casing", "`print` returned no parsable row.");
    }
  } else {
    recorder.answer(
      "D",
      "§8 — is `print` accepted by advanced hunting?",
      `Rejected — ${describeCall(printed)}. Worth recording: like \`getschema\`, \`print\` is core KQL and undocumented for this surface.`,
    );
  }

  // Corroborate against a real table, where the column names are Microsoft's rather than ours.
  const table = tables.find((name) => name === "AlertInfo") ?? tables[0];
  if (table === undefined) {
    recorder.unanswered(
      "D",
      "§7 Q3 corroboration on a real table",
      "No table resolved in section C, so there was nothing to corroborate against.",
    );
    return;
  }

  const real = await hunt(
    context,
    "D2",
    `§7 Q3 corroboration — do ${table}'s PascalCase column names survive onto the result keys?`,
    `${table} | take 1`,
  );
  if (!ok(real)) {
    recorder.unanswered("D", "§7 Q3 corroboration on a real table", describeCall(real));
    return;
  }
  const parsed = huntingResults(real.body);
  if (parsed === undefined) {
    recorder.unanswered(
      "D",
      "§7 Q3 corroboration on a real table",
      `\`${table} | take 1\` returned HTTP ${real.status} but the body did not parse as a hunting result — it carried no \`schema\`/\`results\` pair. That is a different fact from "no rows", and the body is in \`transcript.json\`.`,
    );
    return;
  }
  const row = parsed.results[0];
  if (row === undefined) {
    recorder.unanswered(
      "D",
      "§7 Q3 corroboration on a real table",
      `\`${table} | take 1\` returned no rows within ${context.args.huntTimespan}; the table exists but holds nothing in the window. Re-run with a wider \`--hunt-timespan\`.`,
    );
    return;
  }

  const names = parsed.schema.map((column) => column.name);
  const rowKeys = Object.keys(row);
  const missing = names.filter((name) => !Object.hasOwn(row, name));
  const foldedHits = missing.filter((name) =>
    rowKeys.some((key) => key.toLowerCase() === name.toLowerCase()),
  );

  recorder.answer(
    "D",
    "§7 Q3 corroboration — D4's projection against a real row",
    [
      `\`${table}\`: ${names.length} column(s) in \`schema\`, ${rowKeys.length} key(s) on the first result object.`,
      missing.length === 0
        ? "Every `schema` name is present on the row object, so a positional projection in `schema` order is lossless here."
        : foldedHits.length === missing.length
          ? `**All ${missing.length} missing name(s) are present under a different casing.** This is the re-casing branch of §7 Q3, not D4's missing-key case — indexing by exact \`schema\` name would null out every one of those columns, which is a silent, total data loss rather than a gap.`
          : `${missing.length} \`schema\` name(s) absent from the row object (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}); ${foldedHits.length} of them exist under a different casing. This is exactly the case D4 legislates: emit \`null\` in \`schema\` position, never drop or reorder the column.`,
    ].join(" "),
  );
}
/** Section E — the error contract ADR 010 §3 depends on. */
async function sectionE(context: Context, tables: readonly string[]): Promise<void> {
  const { recorder } = context;
  log("[probe] E — query error contract");
  const table = tables.find((name) => name === "AlertInfo") ?? tables[0] ?? "AlertInfo";

  const semantic = await hunt(
    context,
    "E1",
    "§8 #21, #22 — a semantic failure: unknown column",
    `${table} | project ProbeColumnThatDoesNotExist`,
  );
  const syntactic = await hunt(
    context,
    "E2",
    "§8 #21, #22 — a syntactic failure: stray pipe",
    `${table} | | take 1`,
  );
  const unresolved = await hunt(
    context,
    "E3",
    "§8 #23 — an unresolvable table: 400 or a licensing 403?",
    `${CANARY_TABLE} | take 1`,
  );

  const line = (label: string, call: ProbeCall): string => {
    const error = graphError(call.body);
    const key = innerErrorKey(call.body);
    return [
      `- **${label}** — HTTP ${call.status}`,
      error === undefined ? "no `error` envelope" : `\`error.code\` = \`${error.code}\``,
      key === undefined ? "no nested member" : `nested member spelled \`${key}\``,
      error === undefined ? "" : `message: ${error.message}`,
    ]
      .filter((part) => part !== "")
      .join(", ");
  };

  const calls = [semantic, syntactic, unresolved];
  const codes = calls
    .map((call) => graphError(call.body)?.code)
    .filter((code): code is string => code !== undefined);
  const distinct = new Set(codes);
  const keys = new Set(
    calls.map((call) => innerErrorKey(call.body)).filter((key): key is string => key !== undefined),
  );

  const parts = [
    line("semantic", semantic),
    line("syntactic", syntactic),
    line("unresolvable table", unresolved),
    "",
  ];

  // §8 #22 asks whether the two failure kinds share a `code`. That question needs an envelope from
  // both; "they all share one code" drawn from zero envelopes is not agreement, it is silence.
  const semanticCode = graphError(semantic.body)?.code;
  const syntacticCode = graphError(syntactic.body)?.code;
  if (semanticCode === undefined || syntacticCode === undefined) {
    parts.push(
      `§8 #22 is **unanswered**: ${semanticCode === undefined ? "the semantic failure" : "the syntactic failure"} returned no \`error\` envelope to read a \`code\` from, so nothing here says whether the two kinds are distinguishable by \`code\`.`,
    );
  } else if (distinct.size <= 1) {
    parts.push(
      `All three share one \`code\` (\`${[...distinct][0] ?? ""}\`), so §8 #22 is answered: the connector cannot tell a syntax error from a semantic one by \`code\`, and ADR 010 §3's "preserve the message verbatim" is the only thing that carries the distinction to the model. The \`message\` values do differ ("Fix syntax errors" against "Fix semantic errors"), and Microsoft documents explicitly that message content may change — so that difference is readable by a person and not matchable by code.`,
    );
  } else {
    parts.push(
      `The three do **not** share a \`code\` (${[...distinct].map((code) => `\`${code}\``).join(", ")}), so §8 #22 is answered the other way and a connector may discriminate on \`code\`.`,
    );
  }

  parts.push(
    keys.size > 1
      ? `Both spellings of the nested member were observed in one run (${[...keys].join(", ")}) — the parser must accept both, exactly as §4.2 requires.`
      : keys.size === 1
        ? `Only \`${[...keys][0]}\` was observed here. §4.2's rule to accept both still stands: the documentation uses the other spelling and one run is not a contract.`
        : "No nested member on any of the three.",
    unresolved.status === 400
      ? "An unresolvable table is a **400**, not a 403 — a missing table can never be misread as a permission failure."
      : `An unresolvable table returned **${unresolved.status === 0 ? `no response (${unresolved.transportError ?? "transport failure"})` : unresolved.status}**, not the documented 400. Mechanism 3 rests on that 400, so this run does not support it and §4.2 needs re-reading against E3 in the transcript.`,
  );

  recorder.answer("E", "Error contract — codes, casing and the nested member", parts.join("\n"));

  // The pass-through claim is only about a 400 that actually rejected the column we planted. Any
  // other failure — a throttle, a timeout, an unresolvable *table* because section C found none —
  // says nothing about pass-through, and reporting it as ADR 010 §3 unmet would fail a design
  // requirement in bold on evidence about something else entirely.
  const message = graphError(semantic.body)?.message ?? "";
  if (semantic.status !== 400 || message === "") {
    recorder.unanswered(
      "E",
      "ADR 010 §3 — is the engine diagnostic passed through verbatim?",
      `The semantic probe did not produce a rejected-column diagnostic to inspect — ${describeCall(semantic)}. Nothing here bears on pass-through either way.`,
    );
  } else if (message.includes("ProbeColumnThatDoesNotExist")) {
    recorder.answer(
      "E",
      "ADR 010 §3 — is the engine diagnostic passed through verbatim?",
      "Yes: the rejected column name appears in `error.message`, so the connector can hand the model a diagnostic it can repair its own query from without inventing text.",
    );
  } else if (message.includes(CANARY_TABLE)) {
    recorder.unanswered(
      "E",
      "ADR 010 §3 — is the engine diagnostic passed through verbatim?",
      `The query failed on the **table**, not the column — \`${table}\` did not resolve, so the engine never reached the planted column name. Section C found no usable table for this probe; re-run with section C included.`,
    );
  } else {
    recorder.answer(
      "E",
      "ADR 010 §3 — is the engine diagnostic passed through verbatim?",
      `**No**: the 400 message does not echo the rejected column name (\`${message}\`). ADR 010 §3's actionable-error requirement is not met by pass-through alone here, and Phase 1 must record what it can offer instead.`,
    );
  }
}
/** The `ProbeRows` count a section-F hunt returned, when the body carried one. */
const rowCount = (call: ProbeCall): number | undefined => {
  const first = huntingResults(call.body)?.results[0];
  const value = first?.["ProbeRows"];
  return typeof value === "number" ? value : undefined;
};

/** Section F — §7 Q5, `DEFENDER_WORKSPACE_ID`, and the silent fallback that hides a mistake. */
async function sectionF(context: Context, tables: readonly string[]): Promise<void> {
  const { recorder } = context;
  log("[probe] F — workspaceId behaviour");
  const table = tables.find((name) => name === "AlertInfo") ?? tables[0] ?? "AlertInfo";
  // A count rather than `take 1 | project 1`: the previous form returned the same zero-or-one rows
  // whatever workspace answered, so a "no observable difference" reading was guaranteed by the
  // query and said nothing about the parameter.
  const query = `${table} | summarize ProbeRows = count()`;

  const none = await hunt(context, "F1", "§7 Q5 baseline — no workspaceId", query);
  const bogus = await hunt(
    context,
    "F2",
    "§7 Q5 / §8 #35 — an inaccessible workspaceId: silent fallback, or an error?",
    query,
    { workspaceId: "00000000-0000-0000-0000-0000deadbeef" },
  );

  const baseline = rowCount(none);
  const fallback = rowCount(bogus);

  recorder.answer(
    "F",
    "§7 Q5 / §8 #35 — the `workspaceId` silent fallback",
    !ok(bogus)
      ? `An inaccessible workspaceId is rejected — ${describeCall(bogus)}. The documented silent fallback did not happen here, which is the better outcome: a typo fails loudly rather than answering from the wrong workspace. Phase 1 can surface this as a configuration error.`
      : baseline !== undefined && fallback !== undefined && baseline === fallback
        ? `A workspaceId no tenant owns is accepted (HTTP ${bogus.status}) and returns the **same** count as the unqualified query (${fallback}), which is the documented silent fallback to the caller's primary workspace. A misconfiguration here looks exactly like success, so Phase 1 must not treat a 200 as evidence that \`DEFENDER_WORKSPACE_ID\` was honoured — and \`.env.example\` should say so.`
        : `A workspaceId no tenant owns is accepted (HTTP ${bogus.status}) rather than rejected, so it is not validated. The counts (${baseline ?? "unread"} unqualified, ${fallback ?? "unread"} with the bogus id) do not settle *which* workspace answered, so this shows the absence of validation rather than the fallback itself. Either way Phase 1 cannot read a 200 as confirmation that the configured workspace was used.`,
  );

  if (context.workspaceId === undefined) {
    recorder.unanswered(
      "F",
      "§7 Q5 — does `DEFENDER_WORKSPACE_ID` change anything for this tenant?",
      "`DEFENDER_WORKSPACE_ID` is not set, so the configured-workspace half was not exercised. The validation behaviour above was still measured.",
    );
    return;
  }

  const configured = await hunt(
    context,
    "F3",
    "§7 Q5 — the configured workspaceId against the same query",
    query,
    { workspaceId: context.workspaceId },
  );
  const withWorkspace = rowCount(configured);
  recorder.answer(
    "F",
    "§7 Q5 — does `DEFENDER_WORKSPACE_ID` change anything for this tenant?",
    !ok(configured)
      ? describeCall(configured)
      : `Accepted (HTTP ${configured.status}); \`${table}\` holds ${withWorkspace ?? "an unread number of"} row(s) with it against ${baseline ?? "an unread number"} without. ${
          withWorkspace === baseline
            ? `Identical — but \`${table}\` is a Defender table, and \`workspaceId\` is documented to select a *Sentinel* workspace, so an identical count is the expected result either way and does **not** show the parameter is inert. Settling that needs a Sentinel-only table, which this tenant does not expose (§7 Q9).`
            : "The counts differ, so the parameter changes which data answers and belongs on the artifact's source block."
        }`,
  );
}
/** Section G — row widths, the number D15's band is drawn around. */
async function sectionG(context: Context, tables: readonly string[]): Promise<void> {
  const { recorder } = context;
  const reachable = ROW_WIDTH_TABLES.filter((table) => tables.includes(table));
  log(`[probe] G — row-width sample over ${reachable.length} table(s)`);

  if (reachable.length === 0) {
    recorder.unanswered(
      "G",
      "§7 Q7 residue — the median and p95 serialised width of a row",
      "None of the investigation-facing tables resolved in section C, so no widths were measured and `DEFENDER_QUERY_MAX_ROWS` keeps its interim default of 500.",
    );
    return;
  }

  const lines: string[] = [];
  let widestP95 = 0;
  let sampledTables = 0;
  let brokenProjection = false;

  for (const table of reachable) {
    const call = await hunt(
      context,
      `G.${table}`,
      `D15 — how wide does a ${table} row serialise?`,
      `${table} | take ${context.args.rowWidthSample}`,
    );
    if (!ok(call)) {
      lines.push(`- \`${table}\`: not sampled — ${describeCall(call)}`);
      continue;
    }
    const parsed = huntingResults(call.body);
    if (parsed === undefined) {
      lines.push(`- \`${table}\`: response did not parse as a hunting result`);
      continue;
    }
    if (parsed.results.length === 0) {
      lines.push(
        `- \`${table}\`: ${parsed.schema.length} column(s), no rows within ${context.args.huntTimespan}`,
      );
      continue;
    }

    // Measured as the connector will emit it: positional, in `schema` order (D4). Only the widths
    // survive into the transcript — the rows themselves are tenant telemetry.
    const names = parsed.schema.map((column) => column.name);
    const cells = parsed.results.map((row) => names.map((name) => row[name] ?? null));

    // If the service re-cased its result keys, every lookup above misses and every row serialises
    // as `[null,null,…]` — a narrow, stable, entirely fictional width. A number drawn from that
    // would set `DEFENDER_QUERY_MAX_ROWS` from an artefact of the probe's own projection bug, so
    // the null rate is measured and reported rather than assumed away.
    const total = cells.length * Math.max(1, names.length);
    const nulls = cells.reduce(
      (count, row) => count + row.filter((value) => value === null).length,
      0,
    );
    const nullRate = total === 0 ? 1 : nulls / total;
    if (nullRate > 0.9) brokenProjection = true;

    const widths = cells.map((row) => JSON.stringify(row).length).toSorted((a, b) => a - b);
    const median = quantile(widths, 0.5);
    const p95 = quantile(widths, 0.95);
    widestP95 = Math.max(widestP95, p95);
    sampledTables += 1;
    lines.push(
      `- \`${table}\`: ${names.length} columns, ${widths.length} row(s) — median ${median} chars, p95 ${p95}, max ${widths.at(-1) ?? 0}; ${(nullRate * 100).toFixed(0)}% of cells null${nullRate > 0.9 ? " ⚠️" : ""}`,
    );
    replaceBodyWithWidths(recorder, `G.${table}`, names, widths, nullRate);
  }

  if (sampledTables === 0) {
    recorder.unanswered(
      "G",
      "§7 Q7 residue — the median and p95 serialised width of a row",
      [
        ...lines,
        "",
        `No table returned a row within ${context.args.huntTimespan}, so no width was measured and \`DEFENDER_QUERY_MAX_ROWS\` keeps its interim default of 500. Re-run with a wider \`--hunt-timespan\` (30 days is the hard ceiling).`,
      ].join("\n"),
    );
    return;
  }

  if (brokenProjection) {
    recorder.unanswered(
      "G",
      "§7 Q7 residue — the median and p95 serialised width of a row",
      [
        ...lines,
        "",
        "**Over 90% of projected cells came back `null`**, which almost certainly means the result keys did not match the `schema` names this projection indexes by — the §7 Q3 case. The widths above are the width of a row of nulls, not of data, and no cap may be derived from them. Fix the projection against section D's casing finding and re-run.",
      ].join("\n"),
    );
    return;
  }

  const budget = 40_000;
  const rowsAtBudget = widestP95 === 0 ? 0 : Math.floor(budget / widestP95);
  recorder.answer(
    "G",
    "§7 Q7 residue — the median and p95 serialised width of a row",
    [
      ...lines,
      "",
      `Widest p95 is ${widestP95} chars, so \`INVESTIGATOR_RESULT_MAX_CHARS\` (${budget.toLocaleString("en-US")}) runs out at roughly **${rowsAtBudget} rows** of the widest table.`,
      "",
      `Read that as a **lower bound**, not as the cap. These are *whole* rows — \`| take N\` with no projection — and D15's band is about what a realistic query returns. An investigation that projects eight columns out of forty gets rows several times narrower and therefore fits several times more of them, so the cap has to sit above ${rowsAtBudget} to satisfy D15's "runs out of characters before it runs out of rows". The interim ${500} satisfies the other half of the band — it is far below anything that could drag 100,000 rows across.`,
    ].join("\n"),
  );
}
function replaceBodyWithWidths(
  recorder: Recorder,
  id: string,
  columns: readonly string[],
  widths: readonly number[],
  nullRate: number,
): void {
  const call = recorder.find(id);
  if (call === undefined) return;
  call.body = {
    probeNote: "Rows discarded by the probe; only column names, row widths and the null rate kept.",
    columns,
    serialisedRowWidths: widths,
    // Kept because it is the one number that says whether the widths mean anything: a projection
    // whose keys all missed produces narrow, stable, fictional rows.
    nullCellRate: nullRate,
  };
}

/**
 * Section H — §7 Q2, the measurement Phase 2 is gated on.
 *
 * Turn-0 carries table *names* only (ADR 005 §4), so this measures the block the agent actually
 * receives rather than the full schema. Sentinel's half is read from whatever Sentinel is reachable;
 * with none, the Defender-standalone number is still the number D13 cares about.
 */
async function sectionH(context: Context, defenderTables: readonly string[]): Promise<void> {
  const { recorder } = context;
  log("[probe] H — turn-0 context size with both sources active");

  const sentinelBaseUrl = (process.env["SENTINEL_BASE_URL"] ?? "").replace(/\/+$/, "");
  let sentinelTables: string[] = [];
  let sentinelNote = "no `SENTINEL_BASE_URL` set";

  if (sentinelBaseUrl !== "") {
    try {
      const response = await fetch(`${sentinelBaseUrl}/schema`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        const tables = asRecord(body)?.["tables"];
        if (Array.isArray(tables)) {
          sentinelTables = tables.flatMap((entry) => {
            const name = asString(asRecord(entry)?.["name"]);
            return name === undefined ? [] : [name];
          });
        }
        sentinelNote = `${sentinelTables.length} table(s) from ${sentinelBaseUrl}/schema`;
      } else {
        sentinelNote = `${sentinelBaseUrl}/schema returned HTTP ${response.status}`;
      }
    } catch (error) {
      sentinelNote = `${sentinelBaseUrl}/schema unreachable — ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // One labelled block per source, in SECURITY_SOURCES order, each with its own profile's
  // introduction — the shape §4.2 specifies for turn-0 once several sources are active.
  const defenderBlock = tableBlock(
    "defender",
    "These are the Microsoft Defender advanced hunting tables you can query.",
    defenderTables,
  );
  const sentinelBlock =
    sentinelTables.length === 0
      ? ""
      : tableBlock(
          "sentinel",
          "These are the Microsoft Sentinel tables you can query.",
          sentinelTables,
        );
  const combined = sentinelBlock === "" ? defenderBlock : `${defenderBlock}\n\n${sentinelBlock}`;

  // Zero Defender tables is never a real tenant state — it means section C did not run, was
  // skipped, or lost its control. Reporting it as a measured "0 tables, 27 chars" would be a
  // confident-looking number with nothing behind it, and this finding is one a design decision gets
  // locked against.
  if (defenderTables.length === 0) {
    recorder.unanswered(
      "H",
      "§7 Q2 — how large is turn-0 context with both sources active?",
      `No Defender table set was measured, so the combined size is unknown rather than small. Sentinel's half: ${sentinelNote}${sentinelTables.length === 0 ? "" : `, ${sentinelBlock.length.toLocaleString("en-US")} chars`}. Re-run including section C — Phase 2 is gated on this number and an unmeasured one must not read as a passing one.`,
    );
    return;
  }

  recorder.answer(
    "H",
    "§7 Q2 — how large is turn-0 context with both sources active?",
    [
      `- Defender alone: ${defenderTables.length} table(s), ${defenderBlock.length.toLocaleString("en-US")} chars (~${approxTokens(defenderBlock).toLocaleString("en-US")} tokens).`,
      `- Sentinel: ${sentinelNote}${sentinelTables.length === 0 ? "" : `, ${sentinelBlock.length.toLocaleString("en-US")} chars (~${approxTokens(sentinelBlock).toLocaleString("en-US")} tokens)`}.`,
      `- Both blocks together: ${combined.length.toLocaleString("en-US")} chars (~${approxTokens(combined).toLocaleString("en-US")} tokens).`,
      "",
      "Names only, in the labelled per-source shape §4.2 specifies — not the full schema, which the harness holds and never puts in context (ADR 005 §4). Token figures are a chars/4 estimate, not a tokeniser.",
      sentinelTables.length === 0
        ? "Sentinel's half is unmeasured, so this is the D13 standalone number rather than the Phase 2 one. Re-run with Mock Sentinel up to answer Q2 properly."
        : "This is the number Phase 2 is gated on: if it is too large to be useful context, `roadmap.md` §3 becomes a prerequisite rather than a follow-up, and that is a stop-and-ask under `AGENTS.md` §15.",
    ].join("\n"),
  );
}

/**
 * I — the write path, and whether Sentinel's alerts are reachable at all (PRD-10 Phase 2).
 *
 * Two questions, and they are not the same kind of question.
 *
 * **I1 is a read** and runs whenever section I does: does `alerts_v2` return anything with
 * `serviceSource eq 'microsoftSentinel'`? That settles PRD-10 §10 Q2 — whether this tenant's
 * Sentinel workspace is onboarded to the Defender portal — which decides whether one Graph
 * publisher covers both products here (§4.1 D8) or whether Sentinel alerts are simply out of reach.
 *
 * **I2–I4 write**, and are off unless `--write-probe --write-probe-alert <id>` is passed. Every
 * other request this script makes is a read. A `PATCH` adds a comment to a real alert on a real
 * tenant, Microsoft documents no way to delete one, and the comment carries this project's marker —
 * so an analyst will see it. The probe cannot undo that, which is why it refuses to choose the
 * alert on the operator's behalf.
 *
 * PRD-8 §4.1 D12's rule is what this exists to satisfy: no connector code until a probe has run.
 * PRD-10 §10 Q1 stays open until I2 answers it, and the Graph publisher is not written before then.
 */
async function sectionI(context: Context): Promise<void> {
  const { recorder, args } = context;
  log("[probe] I — Sentinel reachability and the alerts_v2 write path");

  const sentinelAlerts = await context.transport.send({
    section: "I",
    id: "I1",
    question:
      "PRD-10 Q2 — is the Sentinel workspace onboarded, i.e. does alerts_v2 carry its alerts?",
    method: "GET",
    url: alertsUrl(`$filter=${encodeURIComponent("serviceSource eq 'microsoftSentinel'")}&$top=1`),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  if (ok(sentinelAlerts)) {
    const body = asRecord(sentinelAlerts.body);
    const value = body?.["value"];
    const found = Array.isArray(value) ? value.length : 0;
    recorder.answer(
      "I",
      "PRD-10 §10 Q2 — is the Sentinel workspace onboarded to the Defender portal?",
      found > 0
        ? "**Yes.** `alerts_v2` returned at least one alert with `serviceSource: microsoftSentinel`, so Sentinel detections are reachable through the same endpoint, the same token and the same publisher as Defender-native ones (PRD-10 §4.1 D8). No second write path is needed."
        : "**Not demonstrated.** `alerts_v2` answered but returned no `microsoftSentinel` alert. That is either a workspace which is not onboarded, or one that is onboarded and has produced no alerts — the two are indistinguishable from here, and a tenant with an empty `SecurityAlert` table cannot tell them apart. Re-run when Sentinel has fired at least once before concluding anything.",
    );
  } else {
    recorder.unanswered(
      "I",
      "PRD-10 §10 Q2 — is the Sentinel workspace onboarded to the Defender portal?",
      `\`alerts_v2\` returned ${sentinelAlerts.status} for the \`serviceSource\` filter, so onboarding could not be observed.`,
    );
  }

  const targetId = args.writeProbeAlertId;
  if (!args.writeProbe || targetId === undefined) {
    recorder.unanswered(
      "I",
      "PRD-10 §10 Q1 — is `comments` `PATCH`-writable app-only on `alerts_v2`?",
      "The write probe is off. It is opt-in because it cannot be undone: a `PATCH` adds a comment to a real alert, Microsoft documents no delete, and the comment carries this project's marker where an analyst will see it. Answer it with `isophase probe --only I --write-probe --write-probe-alert <alertId>`, choosing an alert you are willing to mark. Until then PRD-8 §4.1 D12 forbids writing the Graph publisher.",
    );
    return;
  }

  const marker = `[soc-agent:${targetId}]`;
  const body = `${marker}\n\nProbe write from \`isophase probe --write-probe\`. This alert's status and classification are unchanged.`;

  const write = await context.transport.send({
    section: "I",
    id: "I2",
    question: "PRD-10 Q1 — does PATCH alerts_v2/{id} accept a comments append app-only?",
    method: "PATCH",
    url: `${alertsUrl().split("?")[0] ?? ""}/${encodeURIComponent(targetId)}`,
    headers: { ...authHeaders(context), "content-type": "application/json" },
    body: { comments: [{ comment: body }] },
  });

  if (!ok(write)) {
    const error = graphError(write.body);
    recorder.answer(
      "I",
      "PRD-10 §10 Q1 — is `comments` `PATCH`-writable app-only on `alerts_v2`?",
      `**No, as attempted.** \`PATCH\` returned ${write.status}${error === undefined ? "" : ` — \`${error.code}\`: ${error.message}`}. PRD-10 §4.1 D1's Graph publisher needs a different target, and the PRD needs an amendment recorded in ADR 013 before Phase 2 proceeds. A 403 here most likely means \`SecurityAlert.ReadWrite.All\` is not consented; a 400 means the payload shape is wrong and the question is still open.`,
    );
    return;
  }

  const readBack = await context.transport.send({
    section: "I",
    id: "I3",
    question: "PRD-10 §4.2 — is the marker readable back, so publication can be idempotent?",
    method: "GET",
    url: `${alertsUrl().split("?")[0] ?? ""}/${encodeURIComponent(targetId)}`,
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  const readBackBody = ok(readBack) ? asRecord(readBack.body) : undefined;
  const comments = readBackBody?.["comments"];
  const serialised = JSON.stringify(comments ?? null);
  const markerFound = serialised.includes(targetId);

  /**
   * The verdict is whether the comment *landed*, not whether the request was accepted.
   *
   * An earlier cut keyed on `write.status === 200` and produced "Yes — and the alert now carries 0
   * comment(s)", which is a sentence that answers its own question wrongly. Graph accepts a `PATCH`
   * carrying a field it does not persist and reports success, so the status code cannot be the
   * evidence: only reading the collection back can.
   */
  const commentCount = Array.isArray(comments) ? comments.length : undefined;
  recorder.answer(
    "I",
    "PRD-10 §10 Q1 — is `comments` `PATCH`-writable app-only on `alerts_v2`?",
    markerFound
      ? `**Yes.** \`PATCH\` returned ${write.status} and read-back found the marker \`${marker}\` among ${commentCount ?? "the"} comment(s), so PRD-10 §4.2's idempotency mechanism works as designed. The comment is permanent; it was written to the alert the operator named.`
      : `**No — and the status code is misleading.** \`PATCH\` returned ${write.status}, but the alert's \`comments\` collection is ${commentCount === undefined ? "absent from the response" : `\`[]\` (${commentCount} entries)`} on both the write response and a fresh read. \`comments\` is returned as a property by both calls, so this is not a projection artifact and \`$expand\` would not change it: **Graph accepted the request and discarded the field.** This is the control for I5 below, which writes to the incident instead (ADR 013 §6).`,
  );

  await incidentWriteProbe(context, readBackBody, marker);
}

/**
 * I4–I6 — the incident comment path (ADR 013 §6, PRD-10 Option A).
 *
 * The alert `PATCH` above is the control: it establishes that Graph accepts and discards, which is
 * what moved publication to the incident. This is the path the Graph publisher will actually take,
 * so the probe takes it first — PRD-8 §4.1 D12, which has now justified itself once.
 *
 * `incidentId` comes off the alert the operator named rather than being asked for separately: that
 * is exactly what `executeRun` will have in hand, and probing a different route than the one that
 * ships proves the wrong thing.
 */
async function incidentWriteProbe(
  context: Context,
  alert: Record<string, unknown> | undefined,
  marker: string,
): Promise<void> {
  const { recorder } = context;
  const incidentId = asString(alert?.["incidentId"]);

  if (incidentId === undefined) {
    recorder.unanswered(
      "I",
      "ADR 013 §6 — does an incident accept an additive comment app-only?",
      "The alert carried no `incidentId`, so no incident could be targeted. Every alert `alerts_v2` returns should be in the incident model (standalone alerts are excluded from the API), which makes this worth investigating rather than working around.",
    );
    return;
  }

  // How noisy Option A is, measured rather than assumed: alerts per incident is what decides
  // whether one incident collects one agent comment or twelve.
  const spread = await context.transport.send({
    section: "I",
    id: "I4",
    question: "ADR 013 §6 — how many alerts share an incident in this tenant?",
    method: "GET",
    url: alertsUrl("$top=100"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  if (ok(spread)) {
    const value = asRecord(spread.body)?.["value"];
    const alerts = Array.isArray(value) ? value : [];
    const incidents = new Set(
      alerts.map((entry) => asString(asRecord(entry)?.["incidentId"]) ?? "(none)"),
    );
    const ratio = incidents.size === 0 ? 0 : alerts.length / incidents.size;
    recorder.answer(
      "I",
      "ADR 013 §6 — how many agent comments will one incident collect?",
      `${alerts.length} alert(s) across ${incidents.size} incident(s) — a mean of ${ratio.toFixed(1)} per incident. Each investigated alert leaves one marked comment, so that mean is what an analyst opening the busiest incident will see. Above roughly three, the per-alert verdict problem in roadmap §8 becomes visible on the incident page rather than only in the run corpus.`,
    );
  }

  const body = `${marker}\n\nProbe write from \`isophase probe --write-probe\`. This incident's status, classification and assignment are unchanged.`;

  const incidentUrl = `${GRAPH}/security/incidents/${encodeURIComponent(incidentId)}`;

  /**
   * Read before writing, exactly as `DefenderClient.publishFindings` does.
   *
   * Three earlier probe runs left three identical comments on one incident, because this took the
   * write path without the publisher's marker check. Graph documents no delete, so each run was
   * permanent noise on a real analyst's case. Probing a path that differs from the shipping one
   * also proves the wrong thing — so this now runs the same read-then-write, and a repeat run
   * reports idempotency instead of demonstrating its absence.
   */
  const before = await context.transport.send({
    section: "I",
    id: "I5a",
    question: "ADR 013 §6 — is this alert's marker already on the incident?",
    method: "GET",
    url: incidentUrl,
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  if (ok(before) && JSON.stringify(before.body ?? null).includes(marker)) {
    recorder.answer(
      "I",
      "ADR 013 §6 — is the incident comments API the write surface for findings?",
      `**Yes, confirmed by idempotency.** The marker \`${marker}\` is already on incident ${incidentId} from an earlier run, so this probe wrote nothing — which is the same read-then-write \`DefenderClient.publishFindings\` performs (PRD-10 §4.2, AC22). Delete the comment in the portal and re-run to exercise the write itself.`,
    );
    return;
  }

  const write = await context.transport.send({
    section: "I",
    id: "I5",
    question: "ADR 013 §6 — does POST /security/incidents/{id}/comments accept a comment app-only?",
    method: "POST",
    url: `${incidentUrl}/comments`,
    headers: { ...authHeaders(context), "content-type": "application/json" },
    body: { "@odata.type": "microsoft.graph.security.alertComment", comment: body },
  });

  const readBack = await context.transport.send({
    section: "I",
    id: "I6",
    question: "ADR 013 §6 — does the comment read back, so publication can be idempotent?",
    method: "GET",
    // A plain GET of the incident: `comments` is not a navigation property, so neither
    // `?$expand=comments` nor `/comments` addresses it — both answer 400. Measured 2026-09-16.
    url: incidentUrl,
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  /**
   * Two independent witnesses, because one of them is the trap this section exists for.
   *
   * The `POST` response body *is* the comments collection — Graph echoes it back — so a write that
   * landed proves itself without a second call. The separate read proves the marker is findable
   * *later*, which is what idempotency actually needs. Keying on the status code alone produced a
   * wrong "Yes" for the alert path and a wrong "No" for this one.
   */
  const inWriteResponse = JSON.stringify(write.body ?? null).includes(marker);
  const inReadBack = ok(readBack) && JSON.stringify(readBack.body ?? null).includes(marker);
  const landed = inWriteResponse || inReadBack;
  const error = graphError(write.body);

  recorder.answer(
    "I",
    "ADR 013 §6 — is the incident comments API the write surface for findings?",
    landed
      ? `**Yes.** \`POST\` returned ${write.status} and the marker \`${marker}\` is present ${inWriteResponse && inReadBack ? "in the write response *and* on a fresh read of the collection" : inWriteResponse ? "in the write response, which echoes the comments collection back" : "on a fresh read of the collection"}. This is the path \`GraphFindingsPublisher\` takes, and the marker makes publication idempotent as PRD-10 §4.2 describes.${inReadBack ? "" : " The separate read did not confirm it — check I6 before relying on read-back for deduplication."} The comment is permanent and is attributed to the app registration by name.`
      : `**No.** \`POST\` returned ${write.status}${error === undefined ? "" : ` — \`${error.code}\`: ${error.message}`}, and the marker ${ok(readBack) ? "did not read back from the incident" : `could not be read back (\`GET\` returned ${readBack.status})`}. A 403 means \`SecurityIncident.ReadWrite.All\` is not consented; anything else means Graph offers this project no additive write surface at all, which is a finding in its own right and sends PRD-10 to its Option C.`,
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface TokenOutcome {
  token?: string;
  status: number;
  body: unknown;
  durationMs: number;
}

/**
 * The raw client-credentials flow — see the file header for why this is not `ClientSecretCredential`.
 *
 * §7 Q10 asks what an unconsented app registration actually does. `.env.example` states that a
 * token is still issued but carries no roles, so every call returns 403; Microsoft documents the
 * 403 and documents that apps must **not** decode Graph tokens to check claims, but does not
 * confirm that the token endpoint issues a role-less token rather than refusing. This records which
 * one happens, and never inspects the token to find out.
 */
async function acquireToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  timeoutMs: number,
): Promise<TokenOutcome> {
  const started = Date.now();
  const response = await fetch(`${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: GRAPH_SCOPE,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = { unparsedText: text.slice(0, 4_096) };
  }

  const token = asString(asRecord(body)?.["access_token"]);
  return {
    ...(token === undefined ? {} : { token }),
    status: response.status,
    body,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderFindings(
  recorder: Recorder,
  args: ProbeArgs,
  stamp: string,
  redactor: Redactor,
): string {
  const bySection = new Map<SectionId, Finding[]>();
  for (const finding of recorder.findings) {
    const list = bySection.get(finding.section) ?? [];
    list.push(finding);
    bySection.set(finding.section, list);
  }

  const titles: Record<SectionId, string> = {
    A: "Authentication and consent",
    B: "alerts_v2 — parameters, ordering and field population",
    C: "Schema discovery",
    D: "Result-key casing and the positional projection",
    E: "The query error contract",
    F: "workspaceId",
    G: "Row widths",
    H: "Turn-0 context size",
    I: "Sentinel reachability and the alerts_v2 write path",
  };

  const answered = recorder.findings.filter((finding) => finding.status === "answered").length;
  const unanswered = recorder.findings.length - answered;
  const throttled = recorder.calls.filter((call) => call.status === 429);

  const lines: string[] = [
    "# Defender probe — findings",
    "",
    `**Run:** ${stamp} · **Sections:** ${[...args.sections].join(", ")} · **Pacing:** ${args.paceMs} ms · **Alert window:** ${args.alertWindow} · **Hunting timespan:** ${args.huntTimespan}`,
    `**Calls:** ${recorder.calls.length} · **Answered:** ${answered} · **Unanswered:** ${unanswered}`,
    "",
    "Generated by `scripts/probe-defender.ts` (PRD-8 Phase 0, D12). Scrubbed of tenant identifiers;",
    "the unscrubbed request/response record is `transcript.json` beside this file, under `.data/`.",
    "",
    "Every heading below names the question it answers, in `docs/research-defender-api.md` §8 or",
    "PRD-8 §7 terms, so a finding can be moved into the research note without being re-derived.",
    "",
  ];

  for (const section of SECTION_IDS) {
    const findings = bySection.get(section);
    if (findings === undefined || findings.length === 0) continue;
    lines.push(`## ${section} — ${titles[section]}`, "");
    for (const finding of findings) {
      lines.push(
        `### ${finding.question}`,
        "",
        finding.status === "unanswered" ? `**Unanswered.** ${finding.answer}` : finding.answer,
        "",
      );
    }
  }

  if (recorder.notes.length > 0) {
    lines.push("## Notes", "", ...recorder.notes.map((note) => `- ${note}`), "");
  }

  lines.push(
    "## §7 Q11 — does a `runHuntingQuery` 429 carry `Retry-After`?",
    "",
    throttled.length === 0
      ? "**Unanswered, and deliberately so.** No call in this run was throttled. Forcing a 429 means either bursting past the request-rate limit or exhausting the tenant's shared hunting CPU allowance, which blocks *every other consumer in the tenant* until the next 15-minute cycle. The probe records `Retry-After` on every response it receives; it does not manufacture one. What this leaves open is only what the typed error can tell an operator — PRD-7 §8 already excluded retries."
      : throttled
          .map(
            (call) =>
              `- \`${call.id}\` returned 429. \`Retry-After\`: ${call.responseHeaders["retry-after"] ?? "**absent**"}. Body code: \`${graphError(call.body)?.code ?? "none"}\`.`,
          )
          .join("\n"),
    "",
    "## Call log",
    "",
    "| id | status | ms | question |",
    "|---|---|---|---|",
    ...recorder.calls.map(
      (call) =>
        `| ${call.id} | ${call.transportError === undefined ? call.status : "transport"} | ${call.durationMs} | ${call.question.replaceAll("|", "\\|")} |`,
    ),
    "",
  );

  return redactor.findings(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The AADSTS code out of a token-endpoint description, and nothing else from it.
 *
 * `error_description` is the only field in this script that reliably carries tenant-identifying
 * prose — directory names, verified domains, the registration's display name — and it is the one
 * field the redactor cannot scrub, because it has no idea what those strings are. The code is the
 * part a reader needs and the part that is safe to publish.
 */
function aadstsCode(description: string | undefined): string {
  const match = description === undefined ? null : /\bAADSTS\d+\b/.exec(description);
  return match === null ? "" : ` (\`${match[0]}\`)`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  const tenantId = process.env["DEFENDER_TENANT_ID"];
  const clientId = process.env["DEFENDER_CLIENT_ID"];
  const clientSecret = process.env["DEFENDER_CLIENT_SECRET"];
  const workspaceId = process.env["DEFENDER_WORKSPACE_ID"];

  // The all-or-none rule of D2, stated here so the probe and the Phase 1 connector agree about what
  // a partial credential group means before the connector exists.
  const missing = Object.entries({
    DEFENDER_TENANT_ID: tenantId,
    DEFENDER_CLIENT_ID: clientId,
    DEFENDER_CLIENT_SECRET: clientSecret,
  })
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);

  if (missing.length === 3) {
    log(
      "[probe] skipped — no Defender credentials configured.\n" +
        "[probe] Set DEFENDER_TENANT_ID, DEFENDER_CLIENT_ID and DEFENDER_CLIENT_SECRET in .env.\n" +
        "[probe] docs/defender-setup.md walks through the app registration and admin consent.",
    );
    return 0;
  }
  if (
    missing.length > 0 ||
    tenantId === undefined ||
    clientId === undefined ||
    clientSecret === undefined
  ) {
    throw new Error(
      `Defender credentials must be set together; missing ${missing.join(", ")}. ` +
        "A partial group is a configuration error and never falls back to another identity (PRD-8 §4.1 D2).",
    );
  }

  const stamp = probeStamp(new Date());
  const outDir = probeOutputDir(stamp, args.outDir);
  await mkdir(outDir, { recursive: true });

  const recorder = new Recorder();
  const transport = new Transport(recorder, args.timeoutMs, args.paceMs);

  log(`[probe] tenant ${tenantId.slice(0, 8)}… → ${outDir}/`);
  log("[probe] A — client credentials against the Graph .default scope");

  const outcome = await acquireToken(tenantId, clientId, clientSecret, args.timeoutMs);
  const redactor = createRedactor(
    [clientSecret, outcome.token ?? ""],
    [
      [tenantId, "[tenant-id]"],
      [clientId, "[client-id]"],
      ...(workspaceId === undefined ? [] : ([[workspaceId, "[workspace-id]"]] as const)),
    ],
  );

  recorder.call({
    section: "A",
    id: "A1",
    question: "§8 #65 — does the token endpoint issue a token, or refuse, for this registration?",
    method: "POST",
    url: `${LOGIN_HOST}/[tenant-id]/oauth2/v2.0/token`,
    requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
    requestBody: {
      grant_type: "client_credentials",
      scope: GRAPH_SCOPE,
      client_secret: "[redacted]",
    },
    status: outcome.status,
    statusText: "",
    durationMs: outcome.durationMs,
    responseHeaders: {},
    body: outcome.body,
  });

  if (outcome.token === undefined) {
    const error = asRecord(outcome.body);
    recorder.answer(
      "A",
      "§7 Q10 — what does an unconsented app registration actually do?",
      // The `error` code is a stable AADSTS identifier and safe to publish. The
      // `error_description` is prose that routinely names the directory, a verified domain or the
      // application's display name, and findings.md is the half meant to be copied into a
      // committed document — so the description stays in the transcript and only its AADSTS code
      // is lifted out.
      `The token endpoint **refused**: HTTP ${outcome.status}, \`${asString(error?.["error"]) ?? "unknown"}\`${aadstsCode(asString(error?.["error_description"]))}. This contradicts \`.env.example\`, which says a role-less token is issued and every call then returns 403. Whichever this is, Phase 1's startup diagnosis should name it rather than surfacing an opaque failure. The full description is in \`transcript.json\`; it is withheld here because it can name the tenant's directory or verified domain.`,
    );
    await writeReport(outDir, recorder, args, stamp, redactor);
    log(`[probe] no token — findings in ${outDir}/findings.md`);
    return 1;
  }

  recorder.answer(
    "A",
    "§7 Q10 — what does an unconsented app registration actually do?",
    `The token endpoint **issued** a token (HTTP ${outcome.status}). Whether it carries the required roles is not knowable from here — Microsoft documents that apps must not decode Graph tokens to check claims — so the answer is completed by the first Graph call below: a 403 there with a token in hand is the missing-consent signature.`,
  );
  recorder.answer(
    "A",
    "§8 #66 — does the client-credentials response include `ext_expires_in`?",
    asRecord(outcome.body)?.["ext_expires_in"] === undefined
      ? "Absent on this response."
      : "Present on this response.",
  );

  /** Set when `alerts_v2` refuses but `runHuntingQuery` answers — see the gate below. */
  let huntingOnly = false;

  const context: Context = {
    args,
    recorder,
    transport,
    token: outcome.token,
    tenantId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };

  // One cheap call before anything expensive: if the registration is unconsented, every section
  // below would return the same 403 and there is no reason to spend the tenant's quota learning it
  // forty more times.
  const reach = await transport.send({
    section: "A",
    id: "A2",
    question: "§8 #64 — what does Graph return when an app-only token lacks the role?",
    method: "GET",
    url: alertsUrl("$top=1"),
    headers: authHeaders(context, PREFER_UNKNOWN_ENUMS),
  });

  if (reach.status === 401 || reach.status === 403) {
    const error = graphError(reach.body);
    recorder.answer(
      "A",
      "§8 #64, #25 — the missing-role failure contract",
      `A token was issued and the first Graph call returned **HTTP ${reach.status}** with \`error.code\` = \`${error?.code ?? "none"}\` — "${error?.message ?? ""}". That is §7 Q10 answered end to end: the token endpoint does not refuse, and the failure surfaces at call time. Phase 1 should map this exact status/code pair to a startup message naming admin consent, rather than passing a bare ${reach.status} to the operator.`,
    );
    const hunted = await hunt(
      context,
      "A3",
      "§8 #25 — is the same failure a 403 or a 401 on runHuntingQuery?",
      "AlertInfo | take 1",
    );
    recorder.answer(
      "A",
      "§8 #25 — runHuntingQuery under the same token",
      `${describeCall(hunted)}. \`ThreatHunting.Read.All\` and the alert-read permission are granted separately, so the two endpoints can disagree — and this run shows whether they do.`,
    );

    // The two permissions are independent, so a refused alerts_v2 does not imply refused hunting.
    // When hunting answers, sections C-G are the majority of Phase 0's questions and every one of
    // them is still reachable; abandoning the run here would throw away the answerable part
    // because the unanswerable part failed first.
    if (!ok(hunted)) {
      recorder.note(
        "Sections B-H were skipped: neither endpoint answered, so every call would repeat this failure and spend quota to do it.",
      );
      await writeReport(outDir, recorder, args, stamp, redactor);
      log(`[probe] access denied on both endpoints — findings in ${outDir}/findings.md`);
      return 1;
    }

    recorder.note(
      `Section B was skipped: \`alerts_v2\` returned ${reach.status} while \`runHuntingQuery\` answered, so this registration holds \`ThreatHunting.Read.All\` but not the alert-read permission. Sections C-G below ran on the hunting endpoint; §7 Q4 and Q8 are unanswerable without alerts.`,
    );
    recorder.unanswered(
      "B",
      "§7 Q4 — is `detectorId` the honest `alertType`? / §7 Q8 — does a Defender alert fill `AlertContext`?",
      `\`alerts_v2\` returned ${reach.status}, so no alert could be read. Grant the alert-read permission and re-run section B.`,
    );
    huntingOnly = true;
  }

  if (ok(reach)) {
    recorder.answer(
      "A",
      "§8 #64 — the missing-role failure contract",
      `Not observed: the first Graph call succeeded with HTTP ${reach.status}, so the alert-read permission is consented and the 403 body shape remains unmeasured. That is the right kind of unanswered — measuring it would mean deliberately removing consent. It says nothing about \`ThreatHunting.Read.All\`, which is granted separately; sections C-G exercise that.`,
    );
  } else {
    // Neither a success nor an authorization failure — a 500, a 404, a transport fault. Reporting
    // it as "succeeded, therefore consented" would put a false statement about the tenant's
    // permission state at the top of findings.md, which is where a reader starts.
    recorder.unanswered(
      "A",
      "§8 #64 — the missing-role failure contract",
      `The reachability call neither succeeded nor failed on authorization — ${describeCall(reach)}. This is **not** evidence that the registration is consented, and it is not the 403 contract either. The sections below still ran; read their failures against this.`,
    );
  }

  let alerts: Record<string, unknown>[] = [];
  let tables: string[] = [];

  // Each section is isolated, because the evidence is the product.
  //
  // A probe run costs real tenant quota and, on a shared hunting allowance, costs it to everybody
  // else too. A section that throws — a transport timeout, an unforeseen response shape — must
  // therefore cost only its own findings, not the six sections that already succeeded and not the
  // report that would have recorded them.
  if (args.sections.has("B") && !huntingOnly)
    alerts = (await runSection(recorder, "B", () => sectionB(context))) ?? [];
  if (args.sections.has("C"))
    tables = (await runSection(recorder, "C", () => sectionC(context))) ?? [];
  if (args.sections.has("D")) await runSection(recorder, "D", () => sectionD(context, tables));
  if (args.sections.has("E")) await runSection(recorder, "E", () => sectionE(context, tables));
  if (args.sections.has("F")) await runSection(recorder, "F", () => sectionF(context, tables));
  if (args.sections.has("G")) await runSection(recorder, "G", () => sectionG(context, tables));
  if (args.sections.has("H")) await runSection(recorder, "H", () => sectionH(context, tables));
  if (args.sections.has("I")) await runSection(recorder, "I", () => sectionI(context));

  const throttled = transport.throttled;
  if (throttled !== undefined) {
    recorder.note(
      `**The run was cut short by a 429 at \`${throttled.id}\`.** The tenant's hunting allowance was exhausted, so the probe stopped rather than accruing further requests against it (Microsoft: "Avoid immediate retries, because all requests accrue against your usage limits"). Every section from that point on is partial or absent — read nothing below as a fact about the tenant. Wait for the next 15-minute cycle and re-run.`,
    );
  }

  if (args.sections.has("C") && args.skipTableProbe) {
    recorder.note(
      "`--skip-table-probe` was passed, so sections D–H ran without a measured table set and fell back to `AlertInfo`.",
    );
  } else if (
    !args.sections.has("C") &&
    ["D", "E", "F", "G", "H"].some((id) => args.sections.has(id as SectionId))
  ) {
    recorder.note(
      "Section C did not run, so sections D–H had no measured table set. D and G report unanswered; E and F fell back to `AlertInfo`; H reports zero Defender tables. Re-run without `--only`, or include C, for the real numbers.",
    );
  }

  await writeReport(outDir, recorder, args, stamp, redactor);

  const unanswered = recorder.findings.filter((finding) => finding.status === "unanswered");
  log(
    `[probe] ${recorder.calls.length} call(s), ${alerts.length} alert(s) sampled, ` +
      `${tables.length} table(s) present, ${unanswered.length} question(s) unanswered`,
  );
  log(`[probe] ${outDir}/findings.md`);
  log(`[probe] ${outDir}/transcript.json`);
  return 0;
}

/**
 * Run one section, recording a failure as a finding rather than as a lost run.
 *
 * Deliberately returns `undefined` on failure instead of rethrowing: the caller substitutes an
 * empty result and the sections after it degrade to "unanswered", which is an outcome §5's exit
 * criterion explicitly accepts.
 */
async function runSection<T>(
  recorder: Recorder,
  id: SectionId,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recorder.unanswered(
      id,
      `Section ${id} did not complete`,
      `It threw before finishing — ${reason}. Everything recorded before the throw is in the call log and in \`transcript.json\`; the questions this section owns are unanswered for this run.`,
    );
    log(`[probe] ${id} failed — ${reason}`);
    return undefined;
  }
}

async function writeReport(
  outDir: string,
  recorder: Recorder,
  args: ProbeArgs,
  stamp: string,
  redactor: Redactor,
): Promise<void> {
  const transcript = {
    stamp,
    args: { ...args, sections: [...args.sections] },
    calls: recorder.calls,
    findings: recorder.findings,
    notes: recorder.notes,
  };
  await Bun.write(
    join(outDir, "transcript.json"),
    `${redactor.transcript(JSON.stringify(transcript, null, 2))}\n`,
  );
  await Bun.write(
    join(outDir, "findings.md"),
    `${renderFindings(recorder, args, stamp, redactor)}\n`,
  );
}

export const USAGE = `isophase probe [--only <sections>] [--pace-ms <ms>] [--skip-table-probe]
               [--alert-window <iso-duration>] [--out <dir>]
               [--write-probe --write-probe-alert <alertId>]

  Probe the Microsoft Graph security API with the DEFENDER_* credential group in .env: confirms
  admin consent, lists the advanced-hunting tables the tenant holds, and records what the service
  supports. Reads the tenant; writes only under .data/defender-probe/<stamp>/.

  --only <A,B,...>      run only the named sections
  --pace-ms <ms>        delay between calls (default 1500; the 45/min floor)
  --skip-table-probe    skip the per-table existence sweep
  --alert-window <P7D>  ISO 8601 duration bounding the alert listing
  --out <dir>           output directory; must sit inside .data/
  --write-probe         opt in to the one write probe (section I); needs --write-probe-alert
  --help                this message`;

/** The dispatcher's view of this command (PRD-11 §4.1 D3). */
export const command: CommandModule = {
  usage: () => Promise.resolve(USAGE),
  run: (argv) => {
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(USAGE);
      return Promise.resolve(0);
    }
    return main(argv);
  },
};

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (error) {
    console.error(`[probe] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
