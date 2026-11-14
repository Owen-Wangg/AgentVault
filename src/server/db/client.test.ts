import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardConnectionErrors } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Shaped like the 57P01 error Neon sends when a test database is dropped WITH (FORCE). */
function terminatedError(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
    client: { user: "neondb_owner", password: "npg_secret_password", host: "ep-x.neon.tech" },
  });
}

describe("database connection errors", () => {
  it("PXY-7: an error on an unguarded pool would crash the process", () => {
    const unguarded = new EventEmitter();
    expect(() => unguarded.emit("error", terminatedError())).toThrow("terminating connection");
  });

  it("PXY-7: a guarded pool handles an idle connection error instead of crashing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = guardConnectionErrors(new EventEmitter());
    expect(() => pool.emit("error", terminatedError())).not.toThrow();
    expect(log).toHaveBeenCalledWith("Database connection error 57P01: terminating connection due to administrator command");
  });

  it("AUD-5: the log line never includes the connection password", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    guardConnectionErrors(new EventEmitter()).emit("error", terminatedError());
    expect(JSON.stringify(log.mock.calls)).not.toContain("npg_secret_password");
  });
});
