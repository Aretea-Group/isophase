/**
 * The `.env` that `isophase init` writes (PRD-11 §4.1 D2, D6).
 *
 * The same variables `.env.example` documents for a clone, cut down to what an operator of the
 * published package needs: the track's credential group uncommented and blank, the three artifact
 * directories set under `.data/` so the live-tenant guard passes on the first run (ADR 009 §5,
 * ADR 011 §13), and the model. Everything else is commented with its default so the file documents
 * itself. Both apps validate exactly this file; there is no second configuration file.
 *
 * Nothing here names a tenant endpoint or a credential of this project's own (AC8): the file is a
 * form for the operator to fill in, and `init` never talks to anything.
 */

export const TRACKS = ["defender", "sentinel"] as const;
export type Track = (typeof TRACKS)[number];

export function isTrack(value: string): value is Track {
  return (TRACKS as readonly string[]).includes(value);
}

/** The directories the template names, which `init` creates. The guard requires `.data/`. */
export const ARTIFACT_DIRECTORIES = {
  RUNS_DIR: ".data/runs",
  INVESTIGATOR_TRACE_DIR: ".data/runs/traces",
  WATCH_CONTROL_SOCKET: ".data/runs/control.sock",
} as const;

/** The variables the operator has to fill in before the next command can succeed. */
export function requiredFields(track: Track): readonly string[] {
  return track === "defender"
    ? ["DEFENDER_TENANT_ID", "DEFENDER_CLIENT_ID", "DEFENDER_CLIENT_SECRET", "OPENAI_API_KEY"]
    : [
        "AZURE_LOG_ANALYTICS_WORKSPACE_ID",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "OPENAI_API_KEY",
      ];
}

/** What to run once the blanks are filled in. Defender has a consent check; Sentinel does not. */
export function nextCommand(track: Track): string {
  return track === "defender" ? "isophase probe" : "isophase investigate --watch";
}

function line(track: Track, forTrack: Track, text: string): string {
  return track === forTrack ? text : `# ${text}`;
}

export function renderEnvTemplate(track: Track, writtenAt: Date): string {
  const d = (text: string): string => line(track, "defender", text);
  const s = (text: string): string => line(track, "sentinel", text);
  return `# isophase — written by \`isophase init --track ${track}\` on ${writtenAt.toISOString()}
#
# Read by \`isophase investigate\`, \`isophase console\` and \`isophase probe\` from the directory
# they run in. A line starting with # is a comment; a commented variable keeps its default.
# Fill in the blank values for your track, then run: ${nextCommand(track)}

# --- Where artifacts go -----------------------------------------------------------------------
# Runs against a real tenant must sit under .data/ (the apps refuse to start otherwise), so all
# three are set here rather than left to their defaults.
RUNS_DIR=${ARTIFACT_DIRECTORIES.RUNS_DIR}
INVESTIGATOR_TRACE_DIR=${ARTIFACT_DIRECTORIES.INVESTIGATOR_TRACE_DIR}
WATCH_CONTROL_SOCKET=${ARTIFACT_DIRECTORIES.WATCH_CONTROL_SOCKET}
# Full transcript per investigation under INVESTIGATOR_TRACE_DIR. Off by default; megabytes apiece.
# INVESTIGATOR_TRACE=false

# --- The source ---------------------------------------------------------------------------------
# Which security source produces the alert queue: defender, sentinel, or both as defender,sentinel
# (then PRIMARY_ALERT_SOURCE names the one that produces alerts).
${d("SECURITY_SOURCES=defender")}
${s("SECURITY_SOURCES=sentinel")}
# PRIMARY_ALERT_SOURCE=

# Microsoft Defender XDR, read through the Microsoft Graph security API. All three are required
# together; a partial group is an error and never falls back to another identity. The app
# registration needs the application permissions SecurityAlert.Read.All and ThreatHunting.Read.All
# with admin consent — \`isophase probe\` confirms it. See docs/defender-setup.md in the repository.
${d("DEFENDER_TENANT_ID=")}
${d("DEFENDER_CLIENT_ID=")}
${d("DEFENDER_CLIENT_SECRET=")}
# Optional: one Log Analytics workspace onboarded to the Defender portal. Leave unset unless you
# know you need it — a wrong id is accepted silently and answered from the primary workspace.
# DEFENDER_WORKSPACE_ID=
# ISO 8601 window the alert listing covers. A quiet tenant may need P30D or P90D.
# DEFENDER_ALERT_WINDOW=P7D
# DEFENDER_QUERY_MAX_ROWS=500
# DEFENDER_TIMEOUT_MS=30000

# Microsoft Sentinel, read through Azure Monitor Logs. \`azure\` selects the real workspace; the
# default, \`mock\`, is the local lab that ships with the repository, not with this package. Use the
# workspace id (a GUID), not its name. Sign in with the service principal below, or leave the
# three AZURE_* credential lines unset to use \`az login\` / \`Connect-AzAccount\`.
${s("SENTINEL_CONNECTOR=azure")}
${s("AZURE_LOG_ANALYTICS_WORKSPACE_ID=")}
${s("AZURE_TENANT_ID=")}
${s("AZURE_CLIENT_ID=")}
${s("AZURE_CLIENT_SECRET=")}
# SENTINEL_TIMEOUT_MS=30000

# --- The model ----------------------------------------------------------------------------------
# The provider's key is read from the environment by the model library, so it lives here too.
INVESTIGATOR_PROVIDER=openai
INVESTIGATOR_MODEL=gpt-5.6-luna
OPENAI_API_KEY=
# Other providers: set INVESTIGATOR_PROVIDER and that provider's key (ANTHROPIC_API_KEY, ...).
# INVESTIGATOR_THINKING_LEVEL=medium
# INVESTIGATOR_MAX_TURNS=50
# INVESTIGATOR_TIMEOUT_MS=1200000
# INVESTIGATOR_RESULT_MAX_CHARS=40000

# Optional web search for the agent. Without it, web_search fails if the agent reaches for it.
# BRAVE_API_KEY=

# --- The unattended loop: isophase investigate --watch --------------------------------------
# WATCH_POLL_INTERVAL_MS=300000
# WATCH_ALERT_WINDOW=PT6H
# Stop when this much has been spent. Unset means no ceiling, which is a choice to make.
# WATCH_SPEND_CEILING_USD=
# Vendor status values to skip, comma-separated. The loop prints the values it sees.
# WATCH_SKIP_STATUSES=
# Write one comment per investigated alert back to the source's case. Off by default.
# PUBLISH_FINDINGS=false
`;
}
