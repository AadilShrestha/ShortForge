import { mkdtemp, readFile, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, spyOn, test } from "bun:test";

import { reauthYouTubeWithLocalCallback } from "../../src/modules/youtube-auth";

const YOUTUBE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

type EnvSnapshot = {
  YOUTUBE_CLIENT_ID: string | undefined;
  YOUTUBE_CLIENT_SECRET: string | undefined;
  YOUTUBE_REDIRECT_URI: string | undefined;
  YOUTUBE_OAUTH_FILE: string | undefined;
};

function snapshotYouTubeEnv(): EnvSnapshot {
  return {
    YOUTUBE_CLIENT_ID: Bun.env.YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET: Bun.env.YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI: Bun.env.YOUTUBE_REDIRECT_URI,
    YOUTUBE_OAUTH_FILE: Bun.env.YOUTUBE_OAUTH_FILE,
  };
}

function restoreYouTubeEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete Bun.env[key];
      continue;
    }

    Bun.env[key] = value;
  }
}

function resolveFetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to reserve loopback port."));
        });
        return;
      }

      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve();
      });
    });
  });
}

describe("youtube-auth reauth", () => {
  test("reauthYouTubeWithLocalCallback captures callback code and persists refresh token", async () => {
    const originalFetch = globalThis.fetch;
    const envSnapshot = snapshotYouTubeEnv();
    const fixtureDir = await mkdtemp(join(tmpdir(), "clipper-youtube-auth-success-"));

    try {
      Bun.env.YOUTUBE_CLIENT_ID = "test-youtube-client-id";
      Bun.env.YOUTUBE_CLIENT_SECRET = "test-youtube-client-secret";

      const port = await reserveLoopbackPort();
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const oauthFilePath = join(fixtureDir, "youtube-oauth.json");

      let tokenRequestBody: string | null = null;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
        const [input, init] = args;
        if (resolveFetchInputUrl(input) === YOUTUBE_TOKEN_ENDPOINT) {
          const body = init?.body;
          tokenRequestBody =
            body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "";

          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "https://www.googleapis.com/auth/youtube.upload",
              refresh_token: "new-refresh-token",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
          );
        }

        return originalFetch(...args);
      }) as typeof fetch;

      let resolveAuthUrl: ((value: string) => void) | null = null;
      const authUrlPromise = new Promise<string>((resolve) => {
        resolveAuthUrl = resolve;
      });

      const reauthPromise = reauthYouTubeWithLocalCallback({
        redirectUri,
        oauthFilePath,
        timeoutMs: 2000,
        openBrowser: false,
        onAuthUrl(authUrl) {
          resolveAuthUrl?.(authUrl);
        },
      });

      const authUrl = await authUrlPromise;
      const state = new URL(authUrl).searchParams.get("state");
      expect(state).toBeString();

      const callbackResponse = await originalFetch(
        `${redirectUri}?code=oauth-callback-code&state=${encodeURIComponent(state ?? "")}`,
      );
      expect(callbackResponse.status).toBe(200);

      const result = await reauthPromise;

      expect(result.redirectUri).toBe(redirectUri);
      expect(result.tokenResponse.refresh_token).toBe("new-refresh-token");
      expect(tokenRequestBody).toContain("code=oauth-callback-code");
      expect(tokenRequestBody).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);

      const persisted = JSON.parse(await readFile(oauthFilePath, "utf8")) as Record<string, unknown>;
      expect(persisted.refreshToken).toBe("new-refresh-token");
      expect(persisted.clientId).toBe("test-youtube-client-id");
      expect(persisted.redirectUri).toBe(redirectUri);
    } finally {
      globalThis.fetch = originalFetch;
      restoreYouTubeEnv(envSnapshot);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("reauthYouTubeWithLocalCallback times out without callback and closes listener", async () => {
    const originalFetch = globalThis.fetch;
    const envSnapshot = snapshotYouTubeEnv();
    const fixtureDir = await mkdtemp(join(tmpdir(), "clipper-youtube-auth-timeout-"));

    try {
      Bun.env.YOUTUBE_CLIENT_ID = "test-youtube-client-id";
      Bun.env.YOUTUBE_CLIENT_SECRET = "test-youtube-client-secret";

      const port = await reserveLoopbackPort();
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const oauthFilePath = join(fixtureDir, "youtube-oauth.json");

      let tokenExchangeCalled = false;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
        const [input] = args;
        if (resolveFetchInputUrl(input) === YOUTUBE_TOKEN_ENDPOINT) {
          tokenExchangeCalled = true;
          throw new Error("Token exchange should not execute when callback never arrives.");
        }

        return originalFetch(...args);
      }) as typeof fetch;

      let resolveAuthUrl: ((value: string) => void) | null = null;
      const authUrlPromise = new Promise<string>((resolve) => {
        resolveAuthUrl = resolve;
      });

      const reauthPromise = reauthYouTubeWithLocalCallback({
        redirectUri,
        oauthFilePath,
        timeoutMs: 60,
        openBrowser: false,
        onAuthUrl(authUrl) {
          resolveAuthUrl?.(authUrl);
        },
      });

      const authUrl = await authUrlPromise;
      expect(authUrl).toContain("accounts.google.com/o/oauth2/v2/auth");

      await expect(reauthPromise).rejects.toThrow("Timed out waiting");
      expect(tokenExchangeCalled).toBeFalse();
      await assertLoopbackPortAvailable(port);
    } finally {
      globalThis.fetch = originalFetch;
      restoreYouTubeEnv(envSnapshot);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
  test("reauthYouTubeWithLocalCallback uses Windows URL handler command", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const envSnapshot = snapshotYouTubeEnv();
    const fixtureDir = await mkdtemp(join(tmpdir(), "clipper-youtube-auth-open-browser-"));
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      ((..._args: Parameters<typeof Bun.spawn>) =>
        ({
          exited: Promise.resolve(0),
          stderr: null,
        }) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
    );

    try {
      Bun.env.YOUTUBE_CLIENT_ID = "test-youtube-client-id";
      Bun.env.YOUTUBE_CLIENT_SECRET = "test-youtube-client-secret";

      const port = await reserveLoopbackPort();
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const oauthFilePath = join(fixtureDir, "youtube-oauth.json");

      let resolveAuthUrl: ((value: string) => void) | null = null;
      const authUrlPromise = new Promise<string>((resolve) => {
        resolveAuthUrl = resolve;
      });

      const reauthPromise = reauthYouTubeWithLocalCallback({
        redirectUri,
        oauthFilePath,
        timeoutMs: 60,
        onAuthUrl(authUrl) {
          resolveAuthUrl?.(authUrl);
        },
      });

      const authUrl = await authUrlPromise;
      await expect(reauthPromise).rejects.toThrow("Timed out waiting");
      expect(spawnSpy).toHaveBeenCalled();

      const [command] = spawnSpy.mock.calls[0] as [string[]];
      expect(command).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", authUrl]);
      await assertLoopbackPortAvailable(port);
    } finally {
      spawnSpy.mockRestore();
      restoreYouTubeEnv(envSnapshot);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
