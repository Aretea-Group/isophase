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
import { TEST_QUERY_GUIDANCE, testSourceBundle } from "./fixtures/source.ts";

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

const ALERT = {
  id: "alert-1",
  title: "Test alert",
  description: "Test description.",
  tactics: [],
  techniques: [],
  entities: [],
  native: null,
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
    source: testSourceBundle(source),
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
  test("adds selected query guidance once, after the first activating tool use", async () => {
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

    await harness.investigate(ALERT);

    expect(contexts.map((context) => context.systemPrompt)).toEqual([
      "Test instructions.",
      `Test instructions.\n\n${TEST_QUERY_GUIDANCE}`,
      `Test instructions.\n\n${TEST_QUERY_GUIDANCE}`,
    ]);
    expect(contexts[0]?.systemPrompt).not.toContain(TEST_QUERY_GUIDANCE);
    expect(JSON.stringify(contexts[0]?.messages)).toContain(
      "Investigate the following test-source alert.",
    );
    expect(JSON.stringify(contexts[0]?.messages)).toContain(
      "These are the TestQL tables available for this investigation.",
    );
  });

  test("does not add query guidance to a web-only investigation", async () => {
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

    await harness.investigate(ALERT);

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

    const result = await harness.investigate(ALERT, {
      onMetrics: (value) => (metrics = value),
    });

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

    const result = await harness.investigate(ALERT);

    expect(result).toEqual(SUMMARY);
    expect(secondContext?.messages.at(-1)).toMatchObject({
      role: "user",
      content: SUBMISSION_DEADLINE_REMINDER,
    });
  });
});
