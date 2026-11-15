import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { advisoryScenarioLock } from "./runner";

afterEach(() => vi.restoreAllMocks());

/**
 * A database whose lock query returns `locked`, and whose transaction
 * then fails to close with `closeError` (if any), as when the idle lock
 * connection is dropped during a long run.
 */
function fakeDb(locked: boolean, closeError?: Error): Db {
  const tx = { execute: async () => ({ rows: [{ locked }] }) };
  return {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const value = await fn(tx);
      if (closeError) throw closeError;
      return value;
    },
  } as unknown as Db;
}

const dropped = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });

describe("advisoryScenarioLock", () => {
  it("AGT-2: runs the scenario when the lock is free, and reports busy without running it when it isn't", async () => {
    const run = vi.fn(async () => "done");
    expect(await advisoryScenarioLock(fakeDb(true), "normal", run)).toEqual({ acquired: true, value: "done" });
    expect(await advisoryScenarioLock(fakeDb(false), "normal", run)).toEqual({ acquired: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("AGT-2: a run that finished keeps its result when closing the lock transaction fails, since the lock is gone either way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await advisoryScenarioLock(fakeDb(true, dropped()), "runaway", async () => 42)).toEqual({ acquired: true, value: 42 });
  });

  it("AGT-2: a failure before the run finished is rethrown, so the route fails closed with 503", async () => {
    await expect(
      advisoryScenarioLock(fakeDb(true), "injection", async () => {
        throw new Error("setup failed");
      }),
    ).rejects.toThrow("setup failed");
    // Busy and then a failed close: nothing ran, so there is no result to keep.
    await expect(advisoryScenarioLock(fakeDb(false, dropped()), "injection", async () => 1)).rejects.toThrow("Connection terminated");
  });
});
