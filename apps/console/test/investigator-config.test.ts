import { describe, expect, test } from "bun:test";

import type { LlamaServerConfig } from "@soc/investigator/model";

import { env } from "../src/env.ts";
import { buildInvestigatorConfig } from "../src/index.ts";

const LLAMA_SERVER: LlamaServerConfig = {
  baseUrl: "https://llama.example/v1",
  modelId: "local-model",
  contextWindow: 65_536,
  maxTokens: 4_096,
  reasoningProfile: "effort",
};

describe("console investigator configuration", () => {
  test("passes a validated thinking level to console-started investigations", () => {
    const config = buildInvestigatorConfig(
      {
        ...env,
        INVESTIGATOR_PROVIDER: "llamacpp",
        INVESTIGATOR_MODEL: LLAMA_SERVER.modelId,
        INVESTIGATOR_THINKING_LEVEL: "medium",
        LLAMA_SERVER_REASONING_PROFILE: "effort",
      },
      {
        runsDir: ".data/runs",
        tracesDir: ".data/runs/traces",
        llamaServer: LLAMA_SERVER,
      },
    );

    expect(config.thinkingLevel).toBe("medium");
    expect(config.llamaServer?.reasoningProfile).toBe("effort");
  });

  test("rejects a thinking level that the configured profile cannot apply", () => {
    expect(() =>
      buildInvestigatorConfig(
        {
          ...env,
          INVESTIGATOR_PROVIDER: "llamacpp",
          INVESTIGATOR_MODEL: LLAMA_SERVER.modelId,
          INVESTIGATOR_THINKING_LEVEL: "medium",
          LLAMA_SERVER_REASONING_PROFILE: "off",
        },
        {
          runsDir: ".data/runs",
          tracesDir: ".data/runs/traces",
          llamaServer: { ...LLAMA_SERVER, reasoningProfile: "off" },
        },
      ),
    ).toThrow('INVESTIGATOR_THINKING_LEVEL must be "off"');
  });
});
