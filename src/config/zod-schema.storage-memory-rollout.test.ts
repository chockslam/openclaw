import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema rollout flags", () => {
  it("rejects removed storage and memory rollout flags", () => {
    expect(() =>
      OpenClawSchema.parse({
        storage: {
          sessions: {
            dualWrite: { enabled: true },
            readFromPostgres: { enabled: false },
          },
        },
        memory: {
          backend: "builtin",
          search: {
            readFromPostgres: { enabled: true },
            writeToPostgres: { enabled: true },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects qmd config surface", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          backend: "qmd",
          qmd: {
            command: "qmd",
          },
        },
      }),
    ).toThrow();
  });
});
