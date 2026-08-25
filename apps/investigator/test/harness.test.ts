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
  createFixtureSourceBundle,
  TEST_QUERY_GUIDANCE,
  testSourceSet,
} from "./fixtures/source.ts";

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
    securitySources: testSourceSet(source),
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
      "Investigate the following Fixture SIEM alert.",
    );
    expect(JSON.stringify(contexts[0]?.messages)).toContain(
      "These are the FixtureQL tables available for this investigation.",
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

describe("FixtureQL source contract", () => {
  test("investigates a native fixture alert through schema, query, guidance, and submission", async () => {
    const fixture = createFixtureSourceBundle();
    const faux = fauxProvider();
    const contexts: Context[] = [];
    const query =
      'MATCH IdentitySessions WHERE principal = "casey.admin" RETURN observed_at, principal, device_trust, action';
    faux.setResponses([
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall("get_security_schema", { tables: ["IdentitySessions"] }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall("query_security_data", { query }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
          stopReason: "toolUse",
        });
      },
    ]);
    let metrics: InvestigationMetrics | undefined;
    const harness = new InvestigationHarness({
      securitySources: testSourceSet(fixture.source),
      webSearch: { search: async () => [] },
      webFetch: {
        fetchPage: async () => ({ url: "https://example.test", title: "", content: "" }),
      },
      model: faux.getModel() as unknown as Model<Api>,
      streamFn: faux.provider.streamSimple,
      instructions: "Test instructions.",
    });

    const result = await harness.investigate(fixture.source.alert, {
      onMetrics: (value) => (metrics = value),
    });

    expect(result).toEqual(SUMMARY);
    expect(fixture.source.alert.native).toEqual(fixture.source.nativeAlert);
    expect(fixture.source.alert).toMatchObject({
      id: "fixture-alert-1",
      severity: "urgent",
      compromisedEntity: "casey.admin",
    });
    expect(fixture.source.queries).toEqual([query]);
    expect(contexts.map((context) => context.systemPrompt)).toEqual([
      "Test instructions.",
      `Test instructions.\n\n${TEST_QUERY_GUIDANCE}`,
      `Test instructions.\n\n${TEST_QUERY_GUIDANCE}`,
    ]);
    const initialMessages = JSON.stringify(contexts[0]?.messages);
    expect(initialMessages).toContain("signalKey");
    expect(initialMessages).toContain("fixture-alert-1");
    expect(initialMessages).toContain("IdentitySessions");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("IdentitySessions(observed_at:instant");
    expect(JSON.stringify(contexts[2]?.messages)).toContain("console_login");
    expect(metrics?.toolCalls).toMatchObject({
      get_security_schema: 1,
      query_security_data: 1,
      submit_investigation: 1,
    });
  });
});
