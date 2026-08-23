import { describe, expect, test } from "bun:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { SecurityDataSource } from "@soc/sentinel-client";

import { InvestigationHarness, type InvestigationMetrics } from "../src/harness.ts";
import { SUBMISSION_DEADLINE_REMINDER, SUBMISSION_FOLLOW_UP } from "../src/instructions.ts";
import {
  addSentinelQueryInstructions,
  SENTINEL_QUERY_INSTRUCTIONS,
} from "../src/query-instructions.ts";

const SUMMARY = {
  tpPercent: 90,
  tpReason: "Observed malicious activity.",
  fpPercent: 10,
  fpReason: "Limited benign uncertainty remains.",
  whatHappened: "The account performed malicious activity after the alert.",
  impact: "confirmed-compromise" as const,
  keyEvidence: ["A decisive telemetry finding."],
  researchDone: ["Checked the relevant telemetry."],
};

function createHarness(
  model: Model<Api>,
  streamFn: ReturnType<typeof fauxProvider>["provider"]["streamSimple"],
  timeoutMs?: number,
): InvestigationHarness {
  const source = {
    getSchema: async () => ({
      tables: [
        {
          name: "SecurityEvent",
          columns: [{ name: "TimeGenerated", type: "datetime" }],
        },
      ],
    }),
  } as unknown as SecurityDataSource;

  return new InvestigationHarness({
    source,
    webSearch: { search: async () => [] },
    webFetch: {
      fetchPage: async () => ({ url: "https://example.test", title: "", content: "" }),
    },
    model,
    streamFn,
    instructions: "Test instructions.",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("InvestigationHarness completion", () => {
  test("adds Sentinel query instructions once, after the first Sentinel tool use", async () => {
    const faux = fauxProvider();
    const contexts: Context[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall("get_security_schema", { tables: ["SecurityEvent"] }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall("get_security_schema", { tables: ["SecurityEvent"] }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
          stopReason: "toolUse",
        });
      },
    ]);
    const harness = createHarness(
      faux.getModel() as unknown as Model<Api>,
      faux.provider.streamSimple,
    );

    await harness.investigate({
      properties: { systemAlertId: "alert-1", alertDisplayName: "Test alert" },
    } as never);

    expect(contexts.map((context) => context.systemPrompt)).toEqual([
      "Test instructions.",
      addSentinelQueryInstructions("Test instructions."),
      addSentinelQueryInstructions("Test instructions."),
    ]);
    expect(contexts[0]?.systemPrompt).not.toContain(SENTINEL_QUERY_INSTRUCTIONS);
  });

  test("does not add Sentinel query instructions to a web-only investigation", async () => {
    const faux = fauxProvider();
    let secondContext: Context | undefined;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("web_search", { query: "indicator" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        secondContext = context;
        return fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
          stopReason: "toolUse",
        });
      },
    ]);
    const harness = createHarness(
      faux.getModel() as unknown as Model<Api>,
      faux.provider.streamSimple,
    );

    await harness.investigate({
      properties: { systemAlertId: "alert-1", alertDisplayName: "Test alert" },
    } as never);

    expect(secondContext?.systemPrompt).toBe("Test instructions.");
  });

  test("gives a prose-only completion one corrective turn to submit structurally", async () => {
    const faux = fauxProvider();
    let secondContext: Context | undefined;
    faux.setResponses([
      fauxAssistantMessage("I have completed the investigation."),
      (context) => {
        secondContext = context;
        return fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
          stopReason: "toolUse",
        });
      },
    ]);
    const harness = createHarness(
      faux.getModel() as unknown as Model<Api>,
      faux.provider.streamSimple,
    );
    let metrics: InvestigationMetrics | undefined;

    const result = await harness.investigate(
      { properties: { systemAlertId: "alert-1", alertDisplayName: "Test alert" } } as never,
      { onMetrics: (value) => (metrics = value) },
    );

    expect(result).toEqual(SUMMARY);
    expect(secondContext?.messages.at(-1)).toMatchObject({
      role: "user",
      content: SUBMISSION_FOLLOW_UP,
    });
    expect(metrics?.turns).toBe(2);
    expect(metrics?.toolCalls["submit_investigation"]).toBe(1);
  });

  test("steers an active investigation toward submission before its hard timeout", async () => {
    const faux = fauxProvider();
    let secondContext: Context | undefined;
    faux.setResponses([
      async () => {
        await Bun.sleep(400);
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "indicator" }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        secondContext = context;
        return fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
          stopReason: "toolUse",
        });
      },
    ]);
    const harness = createHarness(
      faux.getModel() as unknown as Model<Api>,
      faux.provider.streamSimple,
      500,
    );

    const result = await harness.investigate({
      properties: { systemAlertId: "alert-1", alertDisplayName: "Test alert" },
    } as never);

    expect(result).toEqual(SUMMARY);
    expect(secondContext?.messages.at(-1)).toMatchObject({
      role: "user",
      content: SUBMISSION_DEADLINE_REMINDER,
    });
  });
});
