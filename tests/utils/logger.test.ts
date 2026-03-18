import { describe, test, expect, spyOn } from "bun:test";
import { createLogger } from "../../src/utils/logger";

describe("createLogger", () => {
  test("returns object with all log levels", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  test("calls console.log when logging", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("mymod");
    log.info("hello world");
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("[mymod]");
    expect(output).toContain("hello world");
    spy.mockRestore();
  });

  test("includes module name in output", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("downloader");
    log.error("failed");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("[downloader]");
    expect(output).toContain("[ERROR]");
    spy.mockRestore();
  });
});
