import { CopilotClient, type GetAuthStatusResponse } from "@github/copilot-sdk";
import { resolve } from "path";

import { createLogger } from "../utils/logger";

const log = createLogger("github-auth");

const DEFAULT_GITHUB_HOST = "https://github.com";
const DEFAULT_WINDOWS_COPILOT_CLI_PATH = "node_modules/.bin/copilot.exe";
const DEFAULT_POSIX_COPILOT_CLI_PATH = "node_modules/.bin/copilot";

export interface GitHubCopilotLoginOptions {
	host?: string;
}

interface GitHubCopilotAuthStatusOptions {
	githubToken?: string;
}

export async function loginGitHubCopilot(
	options: GitHubCopilotLoginOptions = {},
): Promise<GetAuthStatusResponse> {
	const envToken = getGitHubTokenFromEnv();
	if (envToken) {
		log.info(
			"Detected COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN. Skipping browser OAuth and validating token auth.",
		);
		const authStatus = await getGitHubCopilotAuthStatus({ githubToken: envToken });
		if (!authStatus.isAuthenticated) {
			const statusSuffix = authStatus.statusMessage ? ` ${authStatus.statusMessage}` : "";
			throw new Error(
				`Token authentication is configured but unavailable.${statusSuffix} Confirm the token includes Copilot Requests permission and retry.`,
			);
		}
		return authStatus;
	}

	const cliPath = await resolveCopilotCliPath();
	const host = normalizeGitHubHost(options.host);

	log.info(`Starting GitHub Copilot login flow for ${host}...`);
	log.info(
		"Tip: if your org OAuth approval flow is too broad, use COPILOT_GITHUB_TOKEN with a fine-grained PAT (Copilot Requests permission) to avoid browser consent prompts.",
	);
	const exitCode = await runInteractiveCommand([cliPath, "login", "--host", host]);
	if (exitCode !== 0) {
		throw new Error(`Copilot login command failed with exit code ${exitCode}.`);
	}

	const authStatus = await getGitHubCopilotAuthStatus();
	if (!authStatus.isAuthenticated) {
		const statusSuffix = authStatus.statusMessage ? ` ${authStatus.statusMessage}` : "";
		throw new Error(`Copilot login completed, but authentication is still unavailable.${statusSuffix}`);
	}

	return authStatus;
}

export async function getGitHubCopilotAuthStatus(
	options: GitHubCopilotAuthStatusOptions = {},
): Promise<GetAuthStatusResponse> {
	const token = options.githubToken?.trim();
	const client = token
		? new CopilotClient({ githubToken: token, useLoggedInUser: false })
		: new CopilotClient();
	try {
		await client.start();
		return await client.getAuthStatus();
	} finally {
		await safeStopClient(client);
	}
}

function getGitHubTokenFromEnv(): string | undefined {
	const token =
		Bun.env.COPILOT_GITHUB_TOKEN?.trim() ||
		Bun.env.GH_TOKEN?.trim() ||
		Bun.env.GITHUB_TOKEN?.trim();
	return token && token.length > 0 ? token : undefined;
}

function normalizeGitHubHost(input?: string): string {
	const trimmed = input?.trim();
	if (!trimmed) return DEFAULT_GITHUB_HOST;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

async function resolveCopilotCliPath(): Promise<string> {
	const explicitPath = Bun.env.COPILOT_CLI_PATH?.trim();
	if (explicitPath) {
		if (await Bun.file(explicitPath).exists()) return explicitPath;
		throw new Error(`COPILOT_CLI_PATH does not exist: ${explicitPath}`);
	}

	const projectPath = resolve(
		process.cwd(),
		process.platform === "win32" ? DEFAULT_WINDOWS_COPILOT_CLI_PATH : DEFAULT_POSIX_COPILOT_CLI_PATH,
	);
	if (await Bun.file(projectPath).exists()) return projectPath;

	return "copilot";
}

async function runInteractiveCommand(args: string[]): Promise<number> {
	const proc = Bun.spawn(args, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await proc.exited;
}

async function safeStopClient(client: CopilotClient): Promise<void> {
	try {
		const cleanupErrors = await client.stop();
		if (cleanupErrors.length > 0) {
			log.debug(`Copilot client cleanup reported ${cleanupErrors.length} error(s).`);
		}
	} catch (error) {
		log.debug(`Failed to stop Copilot client cleanly: ${toErrorMessage(error)}`);
	}
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
