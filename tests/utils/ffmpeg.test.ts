import { describe, test, expect } from "bun:test";
import { secondsToSrtTimestamp, secondsToFfmpegTimestamp } from "../../src/utils/ffmpeg";

describe("secondsToSrtTimestamp", () => {
  test("formats zero", () => {
    expect(secondsToSrtTimestamp(0)).toBe("00:00:00,000");
  });

  test("formats fractional seconds", () => {
    expect(secondsToSrtTimestamp(1.5)).toBe("00:00:01,500");
  });

  test("formats minutes", () => {
    expect(secondsToSrtTimestamp(65.25)).toBe("00:01:05,250");
  });

  test("formats hours", () => {
    expect(secondsToSrtTimestamp(3661.123)).toBe("01:01:01,123");
  });

  test("formats large values", () => {
    expect(secondsToSrtTimestamp(7200)).toBe("02:00:00,000");
  });
});

describe("secondsToFfmpegTimestamp", () => {
  test("formats zero", () => {
    expect(secondsToFfmpegTimestamp(0)).toBe("00:00:00.000");
  });

  test("formats fractional seconds", () => {
    expect(secondsToFfmpegTimestamp(90.5)).toBe("00:01:30.500");
  });

  test("formats hours", () => {
    expect(secondsToFfmpegTimestamp(3723.456)).toBe("01:02:03.456");
  });
});
