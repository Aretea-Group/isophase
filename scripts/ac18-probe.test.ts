import { expect, test } from "bun:test";

// PRD-9 AC18 probe: a deliberately red test. This file must never reach main.
test("AC18 probe — this test is meant to fail", () => {
  expect(1).toBe(2);
});
