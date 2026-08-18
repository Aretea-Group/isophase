import { describe, expect, test } from "bun:test";

import { ApiError, apiError } from "../src/index.ts";

describe("apiError", () => {
  test("builds a contract-valid envelope", () => {
    expect(ApiError.parse(apiError("not_found", "no such alert"))).toEqual({
      error: { code: "not_found", message: "no such alert" },
    });
  });

  test("omits details when not supplied", () => {
    expect(apiError("internal_error", "boom").error).not.toHaveProperty("details");
  });

  test("passes backend diagnostics through verbatim", () => {
    const details = { code: "SEM0001", message: "'foo' is not a known table" };

    expect(apiError("query_error", "Query failed", details).error.details).toEqual(details);
  });
});
