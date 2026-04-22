import { describe, expect, test } from "bun:test";

import {
	parseOptionalBackInput,
	parseTypedMenuSelectionInput,
	parseTypedMultiSelectionInput,
	testOnly_buildUploadSummary,
	testOnly_collectUploadPreflightFailures,
	testOnly_resolveRawQuickDigitSelection,
	testOnly_toggleRawQuickDigitSelection,
} from "../../src/cli/interactive";

describe("interactive queue-run prompt parsing", () => {
	test("returns back when /back keyword is entered", () => {
		expect(parseOptionalBackInput("/back")).toEqual({ type: "back" });
		expect(parseOptionalBackInput("  /BACK  ")).toEqual({ type: "back" });
	});

	test("returns null optional value when input is blank", () => {
		expect(parseOptionalBackInput("   ")).toEqual({ type: "value", value: null });
	});

	test("returns trimmed value for normal input", () => {
		expect(parseOptionalBackInput("  https://youtube.com/watch?v=test  ")).toEqual({
			type: "value",
			value: "https://youtube.com/watch?v=test",
		});
	});
});

describe("interactive typed menu parsing", () => {
	test("defaults to first option on empty input", () => {
		expect(parseTypedMenuSelectionInput("", 3, true)).toEqual({
			type: "select",
			index: 0,
		});
	});

	test("supports quit and back shortcuts", () => {
		expect(parseTypedMenuSelectionInput("q", 3, true)).toEqual({ type: "quit" });
		expect(parseTypedMenuSelectionInput("back", 3, true)).toEqual({ type: "back" });
		expect(parseTypedMenuSelectionInput("back", 3, false)).toMatchObject({ type: "invalid" });
	});

	test("validates numeric range", () => {
		expect(parseTypedMenuSelectionInput("2", 3, true)).toEqual({ type: "select", index: 1 });
		expect(parseTypedMenuSelectionInput("9", 3, true)).toMatchObject({ type: "invalid" });
	});
});

describe("interactive multi-selection parsing", () => {
	test("supports mixed indexes and ranges", () => {
		expect(parseTypedMultiSelectionInput("1 3-5", 6)).toEqual({
			type: "select",
			indexes: [0, 2, 3, 4],
		});
	});

	test("deduplicates overlapping ranges and indexes", () => {
		expect(parseTypedMultiSelectionInput("1 2-4 4 3", 6)).toEqual({
			type: "select",
			indexes: [0, 1, 2, 3],
		});
	});

	test("rejects invalid ranges", () => {
		expect(parseTypedMultiSelectionInput("5-3", 6)).toMatchObject({ type: "invalid" });
		expect(parseTypedMultiSelectionInput("2-9", 6)).toMatchObject({ type: "invalid" });
	});
});

describe("interactive upload preflight", () => {
	test("reports missing auth prerequisites for selected platforms", () => {
		const failures = testOnly_collectUploadPreflightFailures({
			profile: {
				id: "p1",
				creatorName: "Creator",
				defaultSourceUrl: null,
				creditName: "Credit",
				creditUrl: null,
				defaultDescription: null,
				outputDir: "./output",
				oauthFilePath: "./data/youtube-oauth.json",
				uploadPrivacy: "unlisted",
				uploadMode: "manual",
				uploadToYouTube: true,
				uploadToTikTok: true,
				uploadToInstagram: true,
				youtubeDescriptionTemplate: null,
				tiktokCaptionTemplate: null,
				instagramCaptionTemplate: null,
				createdAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
			uploadPlatforms: ["youtube", "tiktok", "instagram"],
			fileExists: () => false,
			env: {},
		});

		expect(failures.length).toBeGreaterThanOrEqual(7);
		expect(failures.some((entry) => entry.includes("YOUTUBE_CLIENT_ID"))).toBe(true);
		expect(failures.some((entry) => entry.includes("TIKTOK_CLIENT_KEY"))).toBe(true);
		expect(failures.some((entry) => entry.includes("INSTAGRAM_IG_USER_ID"))).toBe(true);
	});

	test("passes when platform prerequisites are satisfied", () => {
		const failures = testOnly_collectUploadPreflightFailures({
			profile: {
				id: "p1",
				creatorName: "Creator",
				defaultSourceUrl: null,
				creditName: "Credit",
				creditUrl: null,
				defaultDescription: null,
				outputDir: "./output",
				oauthFilePath: "./data/youtube-oauth.json",
				uploadPrivacy: "unlisted",
				uploadMode: "manual",
				uploadToYouTube: true,
				uploadToTikTok: false,
				uploadToInstagram: false,
				youtubeDescriptionTemplate: null,
				tiktokCaptionTemplate: null,
				instagramCaptionTemplate: null,
				createdAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
			uploadPlatforms: ["youtube"],
			fileExists: () => true,
			env: {
				YOUTUBE_CLIENT_ID: "id",
				YOUTUBE_CLIENT_SECRET: "secret",
			},
		});

		expect(failures).toEqual([]);
	});
});

describe("interactive upload summary", () => {
	test("formats upload summary with key decisions", () => {
		const summary = testOnly_buildUploadSummary({
			selectedPlatform: "all",
			resolvedPlatforms: ["youtube", "tiktok"],
			clipSelectionMode: "random",
			selectedClipCount: 4,
			randomCount: 4,
			maxClips: 6,
			descriptionMode: "file",
			metadataFile: "./data/overrides.json",
		});

		expect(summary).toContain("platform=all");
		expect(summary).toContain("resolved=youtube+tiktok");
		expect(summary).toContain("selection=random");
		expect(summary).toContain("random=4");
		expect(summary).toContain("description=file");
		expect(summary).toContain("metadata=./data/overrides.json");
	});
});

describe("interactive raw quick digit helpers", () => {
	test("resolves single-digit quick selection indexes", () => {
		expect(testOnly_resolveRawQuickDigitSelection("1", 5)).toEqual({
			type: "select",
			index: 0,
		});
		expect(testOnly_resolveRawQuickDigitSelection("9", 5)).toMatchObject({
			type: "invalid",
		});
		expect(testOnly_resolveRawQuickDigitSelection("x", 5)).toEqual({ type: "ignore" });
	});

	test("toggles selected index for raw multi quick selection", () => {
		const toggled = new Set<number>([1]);
		expect(testOnly_toggleRawQuickDigitSelection(toggled, "2", 5)).toEqual({
			type: "toggled",
			selected: false,
			index: 1,
		});
		expect(toggled.has(1)).toBe(false);

		expect(testOnly_toggleRawQuickDigitSelection(toggled, "3", 5)).toEqual({
			type: "toggled",
			selected: true,
			index: 2,
		});
		expect(toggled.has(2)).toBe(true);
	});
});
