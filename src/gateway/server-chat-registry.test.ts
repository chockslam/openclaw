import { describe, expect, test } from "vitest";
import { createChatRunRegistry } from "./server-chat.js";

describe("chat run registry", () => {
  test("queues and removes runs per session", async () => {
    const registry = createChatRunRegistry();

    await registry.add("s1", { sessionKey: "main", clientRunId: "c1" });
    await registry.add("s1", { sessionKey: "main", clientRunId: "c2" });

    expect((await registry.peek("s1"))?.clientRunId).toBe("c1");
    expect((await registry.shift("s1"))?.clientRunId).toBe("c1");
    expect((await registry.peek("s1"))?.clientRunId).toBe("c2");

    expect((await registry.remove("s1", "c2"))?.clientRunId).toBe("c2");
    expect(await registry.peek("s1")).toBeUndefined();
  });
});
