import { dirname } from "path";

import { ensureDir } from "../utils/fs";

const TIKTOK_DEFAULT_SCOPE = "video.publish,video.upload";
const TIKTOK_AUTH_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const DEFAULT_TIKTOK_REDIRECT_URI = "http://localhost:3000/tiktok-oauth-callback";
const DEFAULT_TIKTOK_OAUTH_FILE = "./data/tiktok-oauth.json";

type TokenRequestKind = "exchange" | "refresh";

export interface TikTokTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  open_id?: string;
}

interface PersistedTikTokOAuth {
  refreshToken: string;
  refreshTokenExpiresIn: number | null;
  scope: string;
  tokenType: string;
  clientKey: string;
  redirectUri: string;
  openId: string | null;
  savedAt: string;
}

function requiredEnv(name: "TIKTOK_CLIENT_KEY" | "TIKTOK_CLIENT_SECRET"): string {
  const value = Bun.env[name]?.trim();
  if (value) return value;
  throw new Error(`Missing ${name}. Set it in .env and retry.`);
}

function tikTokClientKey(): string {
  return requiredEnv("TIKTOK_CLIENT_KEY");
}

function tikTokClientSecret(): string {
  return requiredEnv("TIKTOK_CLIENT_SECRET");
}

function tikTokRedirectUri(override?: string): string {
  return (
    asNonEmptyString(override) ||
    Bun.env.TIKTOK_REDIRECT_URI?.trim() ||
    DEFAULT_TIKTOK_REDIRECT_URI
  );
}

function tikTokOAuthFilePath(override?: string): string {
  return (
    asNonEmptyString(override) || Bun.env.TIKTOK_OAUTH_FILE?.trim() || DEFAULT_TIKTOK_OAUTH_FILE
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

function providerErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const description = asNonEmptyString(payload.error_description);
  const topLevelError = payload.error;
  const logId = asNonEmptyString(payload.log_id) || asNonEmptyString(payload.logId);

  if (typeof topLevelError === "string") {
    const normalizedError = topLevelError.trim();
    if (!description || description === normalizedError) {
      return logId ? `${normalizedError} (log_id: ${logId})` : normalizedError;
    }

    const message = `${normalizedError}: ${description}`;
    return logId ? `${message} (log_id: ${logId})` : message;
  }

  if (isRecord(topLevelError)) {
    const code = asNonEmptyString(topLevelError.code);
    const message = asNonEmptyString(topLevelError.message);
    const nestedLogId = asNonEmptyString(topLevelError.log_id) || logId;

    if (code && message) {
      const formatted = `${code}: ${message}`;
      return nestedLogId ? `${formatted} (log_id: ${nestedLogId})` : formatted;
    }

    if (message) {
      return nestedLogId ? `${message} (log_id: ${nestedLogId})` : message;
    }

    if (code) {
      return nestedLogId ? `${code} (log_id: ${nestedLogId})` : code;
    }
  }

  if (description) {
    return logId ? `${description} (log_id: ${logId})` : description;
  }

  return null;
}

function parseTikTokTokenResponse(payload: unknown, kind: TokenRequestKind): TikTokTokenResponse {
  if (!isRecord(payload)) {
    throw new Error(`TikTok token ${kind} response was not valid JSON.`);
  }

  const providerMessage = providerErrorMessage(payload);
  if (providerMessage) {
    throw new Error(`TikTok token ${kind} failed: ${providerMessage}`);
  }

  const accessToken = asNonEmptyString(payload.access_token);
  const expiresIn = asPositiveNumber(payload.expires_in);
  const tokenType = asNonEmptyString(payload.token_type);

  if (!accessToken || !expiresIn || !tokenType) {
    throw new Error(`TikTok token ${kind} response is missing required fields.`);
  }

  const scope = asNonEmptyString(payload.scope) ?? undefined;
  const refreshToken = asNonEmptyString(payload.refresh_token) ?? undefined;
  const refreshExpiresIn = asPositiveNumber(payload.refresh_expires_in) ?? undefined;
  const openId = asNonEmptyString(payload.open_id) ?? undefined;

  return {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: tokenType,
    scope,
    refresh_token: refreshToken,
    refresh_expires_in: refreshExpiresIn,
    open_id: openId,
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

async function requestTikTokTokens(
  params: URLSearchParams,
  kind: TokenRequestKind,
): Promise<TikTokTokenResponse> {
  let response: Response;

  try {
    response = await fetch(TIKTOK_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
  } catch {
    throw new Error("Could not reach TikTok OAuth endpoint. Check your network and retry.");
  }

  const { payload, raw } = await parseJsonBody(response);

  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || "unknown provider error";
    throw new Error(`TikTok token ${kind} failed (${response.status}): ${providerMessage}`);
  }

  if (payload === null) {
    throw new Error(`TikTok token ${kind} response was empty.`);
  }

  return parseTikTokTokenResponse(payload, kind);
}

async function persistTikTokOAuth(
  data: PersistedTikTokOAuth,
  oauthFilePathOverride?: string,
): Promise<void> {
  const oauthFilePath = tikTokOAuthFilePath(oauthFilePathOverride);
  ensureDir(dirname(oauthFilePath));

  await Bun.write(oauthFilePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readPersistedTikTokOAuth(
  oauthFilePathOverride?: string,
): Promise<PersistedTikTokOAuth> {
  const oauthFilePath = tikTokOAuthFilePath(oauthFilePathOverride);
  const file = Bun.file(oauthFilePath);

  if (!(await file.exists())) {
    throw new Error(
      `OAuth file not found at ${oauthFilePath}. Run tiktok-auth-url, then tiktok-auth-exchange <code>.`,
    );
  }

  let payload: unknown;

  try {
    const raw = await file.text();
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      `OAuth file at ${oauthFilePath} is invalid. Delete it and run tiktok-auth-exchange <code> again.`,
    );
  }

  if (!isRecord(payload)) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is malformed. Delete it and run tiktok-auth-exchange <code> again.`,
    );
  }

  const refreshToken = asNonEmptyString(payload.refreshToken);
  if (!refreshToken) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is missing refreshToken. Run tiktok-auth-exchange <code> again.`,
    );
  }

  return {
    refreshToken,
    refreshTokenExpiresIn: asPositiveNumber(payload.refreshTokenExpiresIn),
    scope: asNonEmptyString(payload.scope) || TIKTOK_DEFAULT_SCOPE,
    tokenType: asNonEmptyString(payload.tokenType) || "Bearer",
    clientKey: asNonEmptyString(payload.clientKey) || "",
    redirectUri: asNonEmptyString(payload.redirectUri) || tikTokRedirectUri(),
    openId: asNonEmptyString(payload.openId),
    savedAt: asNonEmptyString(payload.savedAt) || "",
  };
}

export interface TikTokAuthUrlOptions {
  redirectUri?: string;
  state?: string;
  scope?: string;
}

export function buildTikTokAuthUrl(options: TikTokAuthUrlOptions = {}): string {
  const params = new URLSearchParams({
    client_key: tikTokClientKey(),
    redirect_uri: tikTokRedirectUri(options.redirectUri),
    response_type: "code",
    scope: asNonEmptyString(options.scope) || TIKTOK_DEFAULT_SCOPE,
  });

  const state = asNonEmptyString(options.state);
  if (state) {
    params.set("state", state);
  }

  return `${TIKTOK_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TikTokTokenExchangeOptions {
  oauthFilePath?: string;
  redirectUri?: string;
}

export async function exchangeCodeForTikTokTokens(
  code: string,
  options: TikTokTokenExchangeOptions = {},
): Promise<TikTokTokenResponse> {
  const normalizedCode = code.trim();
  if (!normalizedCode) {
    throw new Error("Auth code is empty. Run tiktok-auth-url and paste the full code.");
  }

  const redirectUri = tikTokRedirectUri(options.redirectUri);
  const tokenResponse = await requestTikTokTokens(
    new URLSearchParams({
      client_key: tikTokClientKey(),
      client_secret: tikTokClientSecret(),
      code: normalizedCode,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    "exchange",
  );

  const refreshToken = asNonEmptyString(tokenResponse.refresh_token);
  if (!refreshToken) {
    throw new Error(
      "TikTok did not return refresh_token. Re-authorize with tiktok-auth-url and rerun tiktok-auth-exchange <code>.",
    );
  }

  await persistTikTokOAuth(
    {
      refreshToken,
      refreshTokenExpiresIn: tokenResponse.refresh_expires_in ?? null,
      scope: tokenResponse.scope || TIKTOK_DEFAULT_SCOPE,
      tokenType: tokenResponse.token_type,
      clientKey: tikTokClientKey(),
      redirectUri,
      openId: tokenResponse.open_id ?? null,
      savedAt: new Date().toISOString(),
    },
    options.oauthFilePath,
  );

  return tokenResponse;
}

export interface TikTokAccessTokenOptions {
  oauthFilePath?: string;
}

export async function getTikTokAccessToken(
  options: TikTokAccessTokenOptions = {},
): Promise<string> {
  const oauth = await readPersistedTikTokOAuth(options.oauthFilePath);

  const tokenResponse = await requestTikTokTokens(
    new URLSearchParams({
      client_key: tikTokClientKey(),
      client_secret: tikTokClientSecret(),
      refresh_token: oauth.refreshToken,
      grant_type: "refresh_token",
    }),
    "refresh",
  );

  const nextRefreshToken = asNonEmptyString(tokenResponse.refresh_token) || oauth.refreshToken;

  await persistTikTokOAuth(
    {
      refreshToken: nextRefreshToken,
      refreshTokenExpiresIn: tokenResponse.refresh_expires_in ?? oauth.refreshTokenExpiresIn,
      scope: tokenResponse.scope || oauth.scope || TIKTOK_DEFAULT_SCOPE,
      tokenType: tokenResponse.token_type || oauth.tokenType || "Bearer",
      clientKey: tikTokClientKey(),
      redirectUri: oauth.redirectUri,
      openId: tokenResponse.open_id || oauth.openId,
      savedAt: new Date().toISOString(),
    },
    options.oauthFilePath,
  );

  return tokenResponse.access_token;
}
