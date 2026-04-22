import { randomUUID } from "crypto";
import { createServer, type Server as HttpServer, type ServerResponse } from "http";
import { dirname } from "path";

import { ensureDir } from "../utils/fs";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YOUTUBE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const YOUTUBE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_YOUTUBE_REDIRECT_URI = "http://localhost:3000/oauth2callback";
const DEFAULT_YOUTUBE_OAUTH_FILE = "./data/youtube-oauth.json";
const DEFAULT_REAUTH_TIMEOUT_MS = 180_000;
const YOUTUBE_MANUAL_AUTH_GUIDANCE =
  "Use youtube-auth-url and youtube-auth-exchange <code> for non-loopback/manual flows.";

type TokenRequestKind = "exchange" | "refresh";

interface YouTubeTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token?: string;
}

interface PersistedYouTubeOAuth {
  refreshToken: string;
  scope: string;
  tokenType: string;
  clientId: string;
  redirectUri: string;
  savedAt: string;
}

interface LoopbackRedirectConfig {
  listenHost: string;
  displayHost: string;
  port: number;
  pathname: string;
  redirectUri: string;
}

function requiredEnv(name: "YOUTUBE_CLIENT_ID" | "YOUTUBE_CLIENT_SECRET"): string {
  const value = Bun.env[name]?.trim();
  if (value) return value;
  throw new Error(`Missing ${name}. Set it in .env and retry.`);
}

function youtubeRedirectUri(override?: string): string {
  return (
    asNonEmptyString(override) ||
    Bun.env.YOUTUBE_REDIRECT_URI?.trim() ||
    DEFAULT_YOUTUBE_REDIRECT_URI
  );
}

function youtubeOAuthFilePath(override?: string): string {
  return (
    asNonEmptyString(override) || Bun.env.YOUTUBE_OAUTH_FILE?.trim() || DEFAULT_YOUTUBE_OAUTH_FILE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeLoopbackHost(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeLoopbackHost(hostname);
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseLoopbackRedirectUri(redirectUri: string): LoopbackRedirectConfig {
  let parsed: URL;

  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error(`Invalid YOUTUBE_REDIRECT_URI: ${redirectUri}. Expected an absolute URL.`);
  }

  if (parsed.protocol !== "http:") {
    throw new Error(
      `Browser-assisted YouTube reauth only supports loopback http:// redirect URIs. Current value: ${redirectUri}. ${YOUTUBE_MANUAL_AUTH_GUIDANCE}`,
    );
  }

  const normalizedHost = normalizeLoopbackHost(parsed.hostname);
  if (!isLoopbackHost(normalizedHost)) {
    throw new Error(
      `Browser-assisted YouTube reauth requires a loopback redirect host (localhost, 127.0.0.1, or ::1). Current value: ${redirectUri}. ${YOUTUBE_MANUAL_AUTH_GUIDANCE}`,
    );
  }

  const resolvedPort = parsed.port.length > 0 ? Number(parsed.port) : 80;
  if (!Number.isInteger(resolvedPort) || resolvedPort <= 0 || resolvedPort > 65535) {
    throw new Error(`Redirect URI has invalid port: ${redirectUri}`);
  }

  const pathname = parsed.pathname || "/";

  return {
    listenHost: normalizedHost,
    displayHost: normalizedHost === "::1" ? "[::1]" : normalizedHost,
    port: resolvedPort,
    pathname,
    redirectUri,
  };
}

function resolveReauthTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined) {
    return DEFAULT_REAUTH_TIMEOUT_MS;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number.");
  }

  return Math.floor(timeoutMs);
}

function providerErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const description = asNonEmptyString(payload.error_description);
  const err = payload.error;

  if (typeof err === "string") {
    const errorText = err.trim();
    if (!description || description === errorText) return errorText;
    return `${errorText}: ${description}`;
  }

  if (isRecord(err)) {
    const status = asNonEmptyString(err.status);
    const message = asNonEmptyString(err.message);
    if (status && message) return `${status}: ${message}`;
    if (message) return message;
  }

  return description;
}

function parseYouTubeTokenResponse(payload: unknown, kind: TokenRequestKind): YouTubeTokenResponse {
  if (!isRecord(payload)) {
    throw new Error(`YouTube token ${kind} response was not valid JSON.`);
  }

  const accessToken = asNonEmptyString(payload.access_token);
  const expiresIn = asPositiveNumber(payload.expires_in);
  const tokenType = asNonEmptyString(payload.token_type);

  if (!accessToken || !expiresIn || !tokenType) {
    throw new Error(`YouTube token ${kind} response is missing required fields.`);
  }

  const scope = asNonEmptyString(payload.scope) ?? undefined;
  const refreshToken = asNonEmptyString(payload.refresh_token) ?? undefined;

  return {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: tokenType,
    scope,
    refresh_token: refreshToken,
  };
}

async function parseJsonBody(response: Response): Promise<{ payload: unknown; raw: string }> {
  const raw = await response.text();
  if (!raw.trim()) return { payload: null, raw };

  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    return { payload: null, raw };
  }
}

function trimErrorMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

async function requestYouTubeTokens(
  params: URLSearchParams,
  kind: TokenRequestKind,
): Promise<YouTubeTokenResponse> {
  let response: Response;

  try {
    response = await fetch(YOUTUBE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
  } catch {
    throw new Error("Could not reach Google OAuth endpoint. Check your network and retry.");
  }

  const { payload, raw } = await parseJsonBody(response);

  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || "unknown provider error";
    throw new Error(`YouTube token ${kind} failed (${response.status}): ${providerMessage}`);
  }

  if (payload === null) {
    throw new Error(`YouTube token ${kind} response was empty.`);
  }

  return parseYouTubeTokenResponse(payload, kind);
}

async function persistYouTubeOAuth(
  data: PersistedYouTubeOAuth,
  oauthFilePathOverride?: string,
): Promise<void> {
  const oauthFilePath = youtubeOAuthFilePath(oauthFilePathOverride);
  ensureDir(dirname(oauthFilePath));

  await Bun.write(oauthFilePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readPersistedYouTubeOAuth(
  oauthFilePathOverride?: string,
): Promise<PersistedYouTubeOAuth> {
  const oauthFilePath = youtubeOAuthFilePath(oauthFilePathOverride);
  const file = Bun.file(oauthFilePath);

  if (!(await file.exists())) {
    throw new Error(
      `OAuth file not found at ${oauthFilePath}. Run youtube-auth-url, then youtube-auth-exchange <code>.`,
    );
  }

  let payload: unknown;

  try {
    const raw = await file.text();
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      `OAuth file at ${oauthFilePath} is invalid. Delete it and run youtube-auth-exchange <code> again.`,
    );
  }

  if (!isRecord(payload)) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is malformed. Delete it and run youtube-auth-exchange <code> again.`,
    );
  }

  const refreshToken = asNonEmptyString(payload.refreshToken);
  if (!refreshToken) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is missing refreshToken. Run youtube-auth-exchange <code> again.`,
    );
  }

  return {
    refreshToken,
    scope: asNonEmptyString(payload.scope) || YOUTUBE_UPLOAD_SCOPE,
    tokenType: asNonEmptyString(payload.tokenType) || "Bearer",
    clientId: asNonEmptyString(payload.clientId) || "",
    redirectUri: asNonEmptyString(payload.redirectUri) || youtubeRedirectUri(),
    savedAt: asNonEmptyString(payload.savedAt) || "",
  };
}

function localCallbackAddress(config: LoopbackRedirectConfig): string {
  return `http://${config.displayHost}:${config.port}${config.pathname}`;
}

function formatCallbackListenerError(error: unknown, config: LoopbackRedirectConfig): Error {
  if (isRecord(error)) {
    const code = asNonEmptyString(error.code);
    if (code === "EADDRINUSE") {
      return new Error(
        `Could not start local callback listener at ${localCallbackAddress(config)} because port ${config.port} is already in use. Stop the process using that port or pass --redirect-uri with a free loopback port.`,
      );
    }

    if (code === "EACCES") {
      return new Error(
        `Could not start local callback listener at ${localCallbackAddress(config)} due to insufficient permissions. Use a higher loopback port in --redirect-uri and retry.`,
      );
    }
  }

  const fallback = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not start local callback listener at ${localCallbackAddress(config)}: ${fallback}`,
  );
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error) {
        resolve();
        return;
      }

      if (isRecord(error) && asNonEmptyString(error.code) === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function sendCallbackResponse(response: ServerResponse, statusCode: number, message: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(`${message}\n`);
}

async function captureYouTubeAuthCode(
  config: LoopbackRedirectConfig,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const server = createServer();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const callbackPromise = new Promise<string>((resolve, reject) => {
      let settled = false;

      const settleResolve = (code: string): void => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(code);
      };

      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        reject(error);
      };

      server.on("request", (request, response) => {
        if (settled) {
          sendCallbackResponse(response, 409, "OAuth flow already completed. You can close this tab.");
          return;
        }

        const baseUrl = `http://${request.headers.host ?? `${config.displayHost}:${config.port}`}`;
        let callbackUrl: URL;
        try {
          callbackUrl = new URL(request.url ?? "/", baseUrl);
        } catch {
          sendCallbackResponse(response, 400, "Invalid callback URL.");
          settleReject(new Error("YouTube OAuth callback URL was invalid."));
          return;
        }

        if (callbackUrl.pathname !== config.pathname) {
          sendCallbackResponse(response, 404, "Not found.");
          return;
        }

        const callbackError = asNonEmptyString(callbackUrl.searchParams.get("error"));
        const callbackErrorDescription = asNonEmptyString(
          callbackUrl.searchParams.get("error_description"),
        );

        if (callbackError) {
          const fullError = callbackErrorDescription
            ? `${callbackError}: ${callbackErrorDescription}`
            : callbackError;
          sendCallbackResponse(
            response,
            400,
            `YouTube authorization failed (${fullError}). Return to the CLI for details.`,
          );
          settleReject(new Error(`YouTube OAuth callback returned error: ${fullError}`));
          return;
        }

        const callbackCode = asNonEmptyString(callbackUrl.searchParams.get("code"));
        if (!callbackCode) {
          sendCallbackResponse(
            response,
            400,
            "Authorization callback is missing code. Return to the CLI and retry.",
          );
          settleReject(
            new Error(
              "YouTube OAuth callback did not include a code. Retry youtube-auth-reauth and complete consent again.",
            ),
          );
          return;
        }

        const callbackState = asNonEmptyString(callbackUrl.searchParams.get("state"));
        if (!callbackState || callbackState !== expectedState) {
          sendCallbackResponse(
            response,
            400,
            "Authorization state mismatch. Return to the CLI and restart reauth.",
          );
          settleReject(
            new Error(
              "YouTube OAuth callback state mismatch. Restart youtube-auth-reauth and retry from a fresh consent URL.",
            ),
          );
          return;
        }

        sendCallbackResponse(response, 200, "YouTube authorization received. You can close this tab.");
        settleResolve(callbackCode);
      });

      timeoutId = setTimeout(() => {
        settleReject(
          new Error(`Timed out waiting ${timeoutSeconds}s for YouTube OAuth callback at ${localCallbackAddress(config)}. Open the consent URL again, or use the manual flow. If Google shows redirect_uri_mismatch, make sure --redirect-uri (or YOUTUBE_REDIRECT_URI) exactly matches an Authorized redirect URI in Google Cloud Console.`),
        );
      }, timeoutMs);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(formatCallbackListenerError(error, config));
      };

      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.listenHost);
    });

    return await callbackPromise;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    await closeHttpServer(server);
  }
}

function browserOpenCommand(authUrl: string): string[] {
  if (process.platform === "win32") {
    return ["rundll32.exe", "url.dll,FileProtocolHandler", authUrl];
  }

  if (process.platform === "darwin") {
    return ["open", authUrl];
  }

  return ["xdg-open", authUrl];
}

async function openAuthUrlInBrowser(authUrl: string): Promise<void> {
  const command = browserOpenCommand(authUrl);
  let processHandle: ReturnType<typeof Bun.spawn>;

  try {
    processHandle = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch {
    throw new Error(`Could not run browser open command: ${command[0]}`);
  }

  const exitCode = await processHandle.exited;
  if (exitCode === 0) {
    return;
  }

  const stderrStream =
    processHandle.stderr && typeof processHandle.stderr !== "number"
      ? processHandle.stderr
      : null;
  const stderr = stderrStream ? await new Response(stderrStream).text() : "";
  const reason = trimErrorMessage(stderr) || `exit code ${exitCode}`;
  throw new Error(`Browser open command failed (${reason}).`);
}

export interface YouTubeAuthUrlOptions {
  redirectUri?: string;
  state?: string;
}

export function buildYouTubeAuthUrl(options: YouTubeAuthUrlOptions = {}): string {
  const clientId = requiredEnv("YOUTUBE_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: youtubeRedirectUri(options.redirectUri),
    response_type: "code",
    scope: YOUTUBE_UPLOAD_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

  const state = asNonEmptyString(options.state);
  if (state) {
    params.set("state", state);
  }

  return `${YOUTUBE_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface YouTubeTokenExchangeOptions {
  oauthFilePath?: string;
  redirectUri?: string;
}

export async function exchangeCodeForYouTubeTokens(
  code: string,
  options: YouTubeTokenExchangeOptions = {},
): Promise<YouTubeTokenResponse> {
  const normalizedCode = code.trim();
  if (!normalizedCode) {
    throw new Error("Auth code is empty. Run youtube-auth-url and paste the full code.");
  }

  const redirectUri = youtubeRedirectUri(options.redirectUri);
  const tokenResponse = await requestYouTubeTokens(
    new URLSearchParams({
      code: normalizedCode,
      client_id: requiredEnv("YOUTUBE_CLIENT_ID"),
      client_secret: requiredEnv("YOUTUBE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    "exchange",
  );

  const refreshToken = asNonEmptyString(tokenResponse.refresh_token);
  if (!refreshToken) {
    throw new Error(
      "YouTube did not return refresh_token. Revoke app access at myaccount.google.com/permissions, then run youtube-auth-url and youtube-auth-exchange again.",
    );
  }

  await persistYouTubeOAuth(
    {
      refreshToken,
      scope: tokenResponse.scope || YOUTUBE_UPLOAD_SCOPE,
      tokenType: tokenResponse.token_type,
      clientId: requiredEnv("YOUTUBE_CLIENT_ID"),
      redirectUri,
      savedAt: new Date().toISOString(),
    },
    options.oauthFilePath,
  );

  return tokenResponse;
}

export interface YouTubeReauthOptions {
  oauthFilePath?: string;
  redirectUri?: string;
  timeoutMs?: number;
  openBrowser?: boolean;
  onAuthUrl?: (authUrl: string) => void;
  onBrowserOpenFailure?: (error: Error) => void;
}

export interface YouTubeReauthResult {
  authUrl: string;
  redirectUri: string;
  tokenResponse: YouTubeTokenResponse;
}

export async function reauthYouTubeWithLocalCallback(
  options: YouTubeReauthOptions = {},
): Promise<YouTubeReauthResult> {
  const redirectUri = youtubeRedirectUri(options.redirectUri);
  const callbackConfig = parseLoopbackRedirectUri(redirectUri);
  const timeoutMs = resolveReauthTimeoutMs(options.timeoutMs);
  const state = randomUUID();
  const authUrl = buildYouTubeAuthUrl({
    redirectUri,
    state,
  });

  options.onAuthUrl?.(authUrl);

  const callbackCodePromise = captureYouTubeAuthCode(callbackConfig, state, timeoutMs);

  if (options.openBrowser !== false) {
    void openAuthUrlInBrowser(authUrl).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.onBrowserOpenFailure?.(
        new Error(
          `Could not open browser automatically (${message}). Open the printed URL manually and continue authorizing.`,
        ),
      );
    });
  }

  const code = await callbackCodePromise;
  const tokenResponse = await exchangeCodeForYouTubeTokens(code, {
    oauthFilePath: options.oauthFilePath,
    redirectUri,
  });

  return {
    authUrl,
    redirectUri,
    tokenResponse,
  };
}

export interface YouTubeAccessTokenOptions {
  oauthFilePath?: string;
}

export async function getYouTubeAccessToken(
  options: YouTubeAccessTokenOptions = {},
): Promise<string> {
  const oauth = await readPersistedYouTubeOAuth(options.oauthFilePath);

  const tokenResponse = await requestYouTubeTokens(
    new URLSearchParams({
      client_id: requiredEnv("YOUTUBE_CLIENT_ID"),
      client_secret: requiredEnv("YOUTUBE_CLIENT_SECRET"),
      refresh_token: oauth.refreshToken,
      grant_type: "refresh_token",
    }),
    "refresh",
  );

  return tokenResponse.access_token;
}
