import { dirname } from "path";

import { ensureDir } from "../utils/fs";

const DEFAULT_FACEBOOK_GRAPH_VERSION = "v25.0";
const DEFAULT_INSTAGRAM_REDIRECT_URI = "http://localhost:3000/oauth2callback";
const DEFAULT_INSTAGRAM_OAUTH_FILE = "./data/instagram-oauth.json";
const DEFAULT_INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_read_engagement",
] as const;

type TokenRequestKind = "exchange" | "long-lived";

interface InstagramTokenPayload {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

interface PersistedInstagramOAuth {
  accessToken: string;
  tokenType: string;
  scope: string;
  clientId: string;
  redirectUri: string;
  savedAt: string;
  expiresIn?: number;
  expiresAt?: string;
  isLongLived: boolean;
}

interface InstagramOAuthData {
  accessToken: string;
  tokenType: string;
  scope: string;
  clientId: string;
  redirectUri: string;
  savedAt: string;
  expiresIn: number | null;
  expiresAt: string | null;
  isLongLived: boolean;
}

function requiredEnv(name: "INSTAGRAM_CLIENT_ID" | "INSTAGRAM_CLIENT_SECRET"): string {
  const value = Bun.env[name]?.trim();
  if (value) return value;
  throw new Error(`Missing ${name}. Set it in .env and retry.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function providerErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const directDescription = asNonEmptyString(payload.error_description);
  const directMessage = asNonEmptyString(payload.message);
  const error = payload.error;

  if (isRecord(error)) {
    const type = asNonEmptyString(error.type);
    const message =
      asNonEmptyString(error.message) || asNonEmptyString(error.error_user_msg) || directDescription;
    const code = asPositiveNumber(error.code);

    if (type && message && code) return `${type} (${code}): ${message}`;
    if (type && message) return `${type}: ${message}`;
    if (message && code) return `(${code}) ${message}`;
    if (message) return message;
  }

  if (directDescription) return directDescription;
  return directMessage;
}

function trimErrorMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

function instagramRedirectUri(override?: string): string {
  return (
    asNonEmptyString(override) || Bun.env.INSTAGRAM_REDIRECT_URI?.trim() || DEFAULT_INSTAGRAM_REDIRECT_URI
  );
}

function instagramOAuthFilePath(override?: string): string {
  return (
    asNonEmptyString(override) || Bun.env.INSTAGRAM_OAUTH_FILE?.trim() || DEFAULT_INSTAGRAM_OAUTH_FILE
  );
}

function graphApiVersion(): string {
  const candidate = Bun.env.INSTAGRAM_GRAPH_API_VERSION?.trim();
  if (!candidate) return DEFAULT_FACEBOOK_GRAPH_VERSION;

  const normalized = candidate.startsWith("v") ? candidate : `v${candidate}`;
  if (!/^v\d+\.\d+$/.test(normalized)) {
    throw new Error(
      `Invalid INSTAGRAM_GRAPH_API_VERSION "${candidate}". Use format v25.0 or 25.0.`,
    );
  }

  return normalized;
}

function facebookOAuthDialogEndpoint(): string {
  return `https://www.facebook.com/${graphApiVersion()}/dialog/oauth`;
}

function facebookOAuthTokenEndpoint(): string {
  return `https://graph.facebook.com/${graphApiVersion()}/oauth/access_token`;
}

function parseInstagramTokenPayload(payload: unknown, kind: TokenRequestKind): InstagramTokenPayload {
  if (!isRecord(payload)) {
    throw new Error(`Instagram token ${kind} response was not valid JSON.`);
  }

  const accessToken = asNonEmptyString(payload.access_token);
  const tokenType = asNonEmptyString(payload.token_type) || "bearer";

  if (!accessToken) {
    throw new Error(`Instagram token ${kind} response is missing access_token.`);
  }

  const expiresIn = asPositiveNumber(payload.expires_in) ?? undefined;
  const scope = asNonEmptyString(payload.scope) ?? undefined;

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: expiresIn,
    scope,
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

async function requestInstagramTokens(
  params: URLSearchParams,
  kind: TokenRequestKind,
): Promise<InstagramTokenPayload> {
  let response: Response;

  try {
    response = await fetch(`${facebookOAuthTokenEndpoint()}?${params.toString()}`, {
      method: "GET",
    });
  } catch {
    throw new Error("Could not reach Facebook OAuth endpoint. Check your network and retry.");
  }

  const { payload, raw } = await parseJsonBody(response);

  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || "unknown provider error";
    throw new Error(`Instagram token ${kind} failed (${response.status}): ${providerMessage}`);
  }

  if (payload === null) {
    throw new Error(`Instagram token ${kind} response was empty.`);
  }

  return parseInstagramTokenPayload(payload, kind);
}

async function persistInstagramOAuth(
  data: PersistedInstagramOAuth,
  oauthFilePathOverride?: string,
): Promise<void> {
  const oauthFilePath = instagramOAuthFilePath(oauthFilePathOverride);
  ensureDir(dirname(oauthFilePath));
  await Bun.write(oauthFilePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readPersistedInstagramOAuth(
  oauthFilePathOverride?: string,
): Promise<InstagramOAuthData> {
  const oauthFilePath = instagramOAuthFilePath(oauthFilePathOverride);
  const file = Bun.file(oauthFilePath);

  if (!(await file.exists())) {
    throw new Error(
      `OAuth file not found at ${oauthFilePath}. Run instagram-auth-url, then instagram-auth-exchange <code>.`,
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error(
      `OAuth file at ${oauthFilePath} is invalid. Delete it and run instagram-auth-exchange <code> again.`,
    );
  }

  if (!isRecord(payload)) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is malformed. Delete it and run instagram-auth-exchange <code> again.`,
    );
  }

  const accessToken = asNonEmptyString(payload.accessToken);
  if (!accessToken) {
    throw new Error(
      `OAuth file at ${oauthFilePath} is missing accessToken. Run instagram-auth-exchange <code> again.`,
    );
  }

  const expiresIn = asPositiveNumber(payload.expiresIn);
  const expiresAtRaw = asNonEmptyString(payload.expiresAt);
  const expiresAt = expiresAtRaw && !Number.isNaN(Date.parse(expiresAtRaw)) ? expiresAtRaw : null;

  return {
    accessToken,
    tokenType: asNonEmptyString(payload.tokenType) || "bearer",
    scope: asNonEmptyString(payload.scope) || DEFAULT_INSTAGRAM_SCOPES.join(","),
    clientId: asNonEmptyString(payload.clientId) || "",
    redirectUri: asNonEmptyString(payload.redirectUri) || instagramRedirectUri(),
    savedAt: asNonEmptyString(payload.savedAt) || "",
    expiresIn,
    expiresAt,
    isLongLived: payload.isLongLived === true,
  };
}

async function tryExchangeLongLivedToken(accessToken: string): Promise<InstagramTokenPayload | null> {
  try {
    return await requestInstagramTokens(
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: requiredEnv("INSTAGRAM_CLIENT_ID"),
        client_secret: requiredEnv("INSTAGRAM_CLIENT_SECRET"),
        fb_exchange_token: accessToken,
      }),
      "long-lived",
    );
  } catch {
    return null;
  }
}

function expiresAtFromNow(expiresIn: number | undefined): string | null {
  if (!expiresIn) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

export interface InstagramAuthUrlOptions {
  redirectUri?: string;
  state?: string;
  scope?: string | string[];
}

export function buildInstagramAuthUrl(options: InstagramAuthUrlOptions = {}): string {
  const scopeFromOptions = options.scope;
  const scope =
    Array.isArray(scopeFromOptions)
      ? scopeFromOptions.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(",")
      : asNonEmptyString(scopeFromOptions) || DEFAULT_INSTAGRAM_SCOPES.join(",");

  if (!scope) {
    throw new Error("Instagram OAuth scope is empty. Provide at least one scope.");
  }

  const params = new URLSearchParams({
    client_id: requiredEnv("INSTAGRAM_CLIENT_ID"),
    redirect_uri: instagramRedirectUri(options.redirectUri),
    response_type: "code",
    scope,
  });

  const state = asNonEmptyString(options.state);
  if (state) {
    params.set("state", state);
  }

  return `${facebookOAuthDialogEndpoint()}?${params.toString()}`;
}

export interface InstagramTokenExchangeOptions {
  oauthFilePath?: string;
  redirectUri?: string;
  scope?: string | string[];
  preferLongLivedToken?: boolean;
}

export interface InstagramTokenExchangeResult {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope: string;
  long_lived: boolean;
}

export async function exchangeCodeForInstagramTokens(
  code: string,
  options: InstagramTokenExchangeOptions = {},
): Promise<InstagramTokenExchangeResult> {
  const normalizedCode = code.trim();
  if (!normalizedCode) {
    throw new Error("Auth code is empty. Run instagram-auth-url and paste the full code.");
  }

  const redirectUri = instagramRedirectUri(options.redirectUri);
  const shortLivedToken = await requestInstagramTokens(
    new URLSearchParams({
      client_id: requiredEnv("INSTAGRAM_CLIENT_ID"),
      client_secret: requiredEnv("INSTAGRAM_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      code: normalizedCode,
    }),
    "exchange",
  );

  const shouldPreferLongLived = options.preferLongLivedToken !== false;
  const longLivedToken = shouldPreferLongLived
    ? await tryExchangeLongLivedToken(shortLivedToken.access_token)
    : null;

  const selectedToken = longLivedToken || shortLivedToken;
  const scopeFromOptions = options.scope;
  const normalizedScope =
    Array.isArray(scopeFromOptions)
      ? scopeFromOptions.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(",")
      : asNonEmptyString(scopeFromOptions) || DEFAULT_INSTAGRAM_SCOPES.join(",");

  await persistInstagramOAuth(
    {
      accessToken: selectedToken.access_token,
      tokenType: selectedToken.token_type,
      scope: selectedToken.scope || normalizedScope,
      clientId: requiredEnv("INSTAGRAM_CLIENT_ID"),
      redirectUri,
      savedAt: new Date().toISOString(),
      expiresIn: selectedToken.expires_in,
      expiresAt: expiresAtFromNow(selectedToken.expires_in) || undefined,
      isLongLived: longLivedToken !== null,
    },
    options.oauthFilePath,
  );

  return {
    access_token: selectedToken.access_token,
    token_type: selectedToken.token_type,
    expires_in: selectedToken.expires_in,
    scope: selectedToken.scope || normalizedScope,
    long_lived: longLivedToken !== null,
  };
}

export interface InstagramAccessTokenOptions {
  oauthFilePath?: string;
}

export async function getInstagramAccessToken(
  options: InstagramAccessTokenOptions = {},
): Promise<string> {
  const oauth = await readPersistedInstagramOAuth(options.oauthFilePath);

  if (oauth.expiresAt) {
    const expiresAt = Date.parse(oauth.expiresAt);
    if (!Number.isNaN(expiresAt) && Date.now() >= expiresAt) {
      throw new Error(
        `Instagram access token expired at ${oauth.expiresAt}. Run instagram-auth-url and instagram-auth-exchange <code> again.`,
      );
    }
  }

  return oauth.accessToken;
}
