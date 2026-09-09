import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { eventually, mcpMock, needs, server, test } from "@openwork/testkit";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

for (const issuerSupport of [true, false, undefined]) {
  const metadataLabel = issuerSupport === undefined ? "absent" : String(issuerSupport);

  // This callback journey was missing from the boundary lane: previous coverage
  // used providers that never advertised RFC 9207 response issuer support.
  test(`local OAuth (issuer support ${metadataLabel}) validates callbacks and preserves usable credentials`, { timeout: 120_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    const root = await mkdtemp(join(tmpdir(), "openwork-oauth-issuer-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { handle: provider } = await mcpMock({ authorizationResponseIssuerSupported: issuerSupport }).boot(place);
    const metadata: unknown = await (await fetch(`${provider.url}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })).json();
    expect(metadata).toHaveProperty("issuer", provider.url);
    if (!isRecord(metadata)) throw new Error("Provider metadata missing");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(issuerSupport);
    const token = "synthetic-local-oauth-client";
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
    const server = bootServer({
      ...inherited,
      XDG_CONFIG_HOME: join(root, "config"),
      OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
      OPENWORK_ALLOW_PRIVATE_MCP_URLS: "1",
      OPENWORK_ENCRYPTION_KEY: "synthetic-oauth-vault-key",
    }, token, workspace, () => {});
    try {
      const base = await server.listening;
      const request = (path: string, body?: unknown) => fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const workspaces: unknown = await (await request("/workspaces")).json();
      if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Workspace missing");
      const path = `/workspace/${workspaces.items[0].id}/mcp`;
      const tokenRequests = async () => (await provider.requests()).filter((entry) => entry.path === "/token").length;
      for (const mode of issuerSupport === true ? ["mismatch", "missing", "empty", "state", "valid"] : ["state", "valid"]) {
        const name = `issuer-${mode}`;
        const added = await request(`${path}/managed`, { name, url: provider.mcpUrl });
        const result: unknown = await added.json();
        expect(added.status, JSON.stringify(result)).toBe(201);
        if (!isRecord(result) || typeof result.authorizeUrl !== "string") throw new Error("Authorization URL missing");
        const authorize = new URL(result.authorizeUrl);
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
        const redirect = await fetch(authorize, { redirect: "manual" });
        expect(redirect.status).toBe(302);
        const callback = new URL(redirect.headers.get("location")!);
        expect(callback.searchParams.get("iss")).toBe(issuerSupport === true ? provider.url : null);
        if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
        if (mode === "missing") callback.searchParams.delete("iss");
        if (mode === "empty") callback.searchParams.set("iss", "");
        if (mode === "state") callback.searchParams.set("state", "invalid-state");
        const before = await tokenRequests();
        const completed = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
        const html = await completed.text();
        const connection: unknown = await (await request(`${path}/${name}/managed`)).json();
        if (mode !== "valid") {
          expect(completed.ok, html).toBe(false);
          expect(await tokenRequests()).toBe(before);
          expect(connection).not.toMatchObject({ status: "connected" });
          evidence.recordAssertionEvidence(`Reject ${mode} callback before token exchange`, `HTTP ${completed.status}; zero token requests; connection is not connected.`, true);
        } else {
          expect(completed.status, html).toBe(200);
          expect(html).toContain("Connected");
          expect(connection).toMatchObject({ status: "connected" });
          expect(await tokenRequests()).toBe(before + 1);
          evidence.recordAssertionEvidence(`Sign-in supports ${metadataLabel} issuer-support metadata with PKCE`, "Verified advertised metadata and callback issuer presence; provider required S256 and accepted exactly one code exchange; callback and server report connected.", true);
          const replay = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
          expect(replay.ok).toBe(false);
          expect(await tokenRequests()).toBe(before + 1);
          // Replay currently marks the local status reconnect_required on both dev
          // and this fix. Assert credential usability separately from that inherited defect.
          const reused = await request(`${path}/${name}/managed/connect`, {});
          expect(reused.status).toBe(200);
          expect(await reused.json()).toMatchObject({ status: "connected" });
          expect(await tokenRequests()).toBe(before + 1);
          evidence.recordAssertionEvidence("Replay preserves usable credentials", "Replay rejected without another token exchange; connecting again reused persisted credentials and passed authenticated tool discovery without OAuth.", true);
        }
      }
    } finally {
      await stopChild(server.child);
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Den OAuth (issuer support ${metadataLabel}) validates callbacks and preserves usable credentials`, { timeout: 300_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"] });
    await using den = await server({
      place, web: false,
      mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: issuerSupport }) },
      org: { name: `OAuth Issuer ${Date.now()}`, members: {} },
    });
    const provider = den.mocks.connector;
    const metadata: unknown = await (await fetch(`${provider.url}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })).json();
    if (!isRecord(metadata)) throw new Error("Provider metadata missing");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(issuerSupport);
    const headers = { authorization: `Bearer ${den.admin.token}` };
    for (const mode of issuerSupport === true ? ["mismatch", "valid"] : ["valid"]) {
      const created = await denFetch(den.admin, "/v1/mcp-connections", {
        method: "POST", headers,
        body: JSON.stringify({ name: `Issuer ${mode}`, url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
      });
      expect(created.response.status, created.text).toBe(200);
      if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
      const id = created.body.id;
      const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
      expect(started.response.status, started.text).toBe(200);
      if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
      const redirect = await fetch(started.body.authorizeUrl, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      const callback = new URL(redirect.headers.get("location")!);
      expect(callback.searchParams.get("iss")).toBe(issuerSupport === true ? provider.url : null);
      if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
      const before = (await provider.requests()).filter((entry) => entry.path === "/token").length;
      const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const html = await completed.text();
      expect(completed.status, html).toBe(mode === "valid" ? 200 : 400);
      expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + (mode === "valid" ? 1 : 0));
      const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
      expect(listed.response.status).toBe(200);
      if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
      const connection = listed.body.connections.find((entry) => isRecord(entry) && entry.id === id);
      expect(connection).toMatchObject({ connected: mode === "valid" });
      evidence.recordAssertionEvidence(
        `Den ${mode === "valid" ? `completes sign-in with ${metadataLabel} issuer-support metadata` : "rejects a mismatched issuer before exchange"}`,
        `Callback returned HTTP ${completed.status}; provider observed ${mode === "valid" ? "exactly one" : "zero"} token requests.`, true,
      );
      if (mode === "valid") {
        const replay = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        expect(replay.status).toBe(400);
        expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + 1);
        const afterReplay = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
        expect(afterReplay.response.status).toBe(200);
        if (!isRecord(afterReplay.body) || !Array.isArray(afterReplay.body.connections)) throw new Error("Connections missing after replay");
        expect(afterReplay.body.connections.find((entry) => isRecord(entry) && entry.id === id)).toMatchObject({ connected: true });
        const reused = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
        expect(reused.response.status, reused.text).toBe(200);
        expect(reused.body).toMatchObject({ status: "connected", authorizeUrl: null });
        expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + 1);
        evidence.recordAssertionEvidence("Den replay preserves usable credentials", "Replay rejected; a subsequent connection check reused saved credentials and remained connected without another token exchange.", true);
      }
    }
  });
}

test("Den OAuth callback distinguishes resource rejection from token exchange failure without restarting interactive authorization", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: true }) },
    org: { name: `OAuth Callback Boundaries ${Date.now()}`, members: {} },
  });
  const provider = den.mocks.connector;
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const secret = "synthetic-callback-secret";
  for (const fault of ["resource-401", "resource-403", "token-400"]) {
    const resourceStatus = fault === "resource-401" ? 401 : fault === "resource-403" ? 403 : undefined;
    const expectedCode = resourceStatus === 401 ? "MCP_OAUTH_HTTP_401"
      : resourceStatus === 403 ? "MCP_OAUTH_INSUFFICIENT_SCOPE" : "MCP_OAUTH_INVALID_GRANT";
    const expectedPhase = resourceStatus === undefined ? "AUTH_TOKEN_ACQUISITION" : "AUTH_RESOURCE_VALIDATION";
    await provider.configureOAuthCallback({
      issueRefreshToken: false,
      ...(resourceStatus === undefined
        ? { tokenErrorDescription: `Synthetic code rejected; client_secret=${secret}` }
        : { resourceStatus }),
    });
    const firstRequest = (await provider.requests()).length;
    const created = await denFetch(den.admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name: `Callback ${fault}`, url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
    });
    expect(created.response.status).toBe(200);
    if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
    expect(created.body.connected).toBe(false);
    const id = created.body.id;
    const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
    expect(started.response.status).toBe(200);
    if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
    expect(started.body.status).toBe("needs_auth");
    const redirect = await fetch(started.body.authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location");
    if (!location) throw new Error("OAuth callback location missing");
    const callback = new URL(location);
    expect(callback.searchParams.get("iss")).toBe(provider.url);
    expect(Boolean(callback.searchParams.get("code") && callback.searchParams.get("state"))).toBe(true);
    const before = await provider.requests();
    const setup = before.slice(firstRequest);
    expect(setup.filter((entry) => entry.path === "/register").length).toBe(1);
    expect(setup.filter((entry) => entry.path === "/authorize").length).toBe(1);
    expect(setup.filter((entry) => entry.path === "/token").length).toBe(0);
    evidence.recordAssertionEvidence(`${fault}: real authorization reaches a valid issuer callback`,
      "Created a disconnected shared connection; connect/start returned needs_auth; one registration and authorization produced HTTP 302 with code, state, and the expected issuer; no exchange yet.", true);

    const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const html = await completed.text();
    const referenceId = html.match(/Diagnostic reference:\s*<code>([^<]+)<\/code>/)?.[1];
    const callbackRejected = completed.status === 400
      && completed.headers.get("content-type")?.startsWith("text/html") === true
      && html.includes('role="alert"') && html.includes("Connection failed")
      && html.includes(resourceStatus === undefined
        ? "The authorization server rejected the code or token refresh exchange."
        : "The MCP resource rejected the supplied authorization.")
      && !html.includes("Connection complete") && Boolean(referenceId);
    evidence.recordAssertionEvidence(`${fault}: callback explains the failing boundary`,
      `HTTP ${completed.status}; expected an HTML failure alert with a diagnostic reference and a ${expectedPhase} message, not a success page.`, callbackRejected);
    expect(callbackRejected).toBe(true);
    if (!referenceId) throw new Error("Callback diagnostic reference missing");

    // Callback HTML exposes only a message/reference; connection JSON has no diagnostic.
    // Match the real callback's structured log, never a fabricated JSON callback response.
    const diagnostic = await eventually(async () => {
      for (const line of (await den.apiLog()).split("\n")) {
        if (!line.includes(referenceId)) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isRecord(entry) || entry.connection_id !== id
          || entry.message !== "external_mcp_connect_callback_token_exchange_failed"
          || !isRecord(entry.diagnostic) || entry.diagnostic.referenceId !== referenceId) continue;
        return {
          classified: entry.diagnostic.code === expectedCode && entry.diagnostic.phase === expectedPhase
            && entry.diagnostic.httpStatus === (resourceStatus ?? 400),
          missingAuthorizationId: line.includes("MCP_OAUTH_AUTHORIZATION_ID_REQUIRED"),
          sdkInvalidGrant: Array.isArray(entry.causeChain) && entry.causeChain.some((cause) =>
            isRecord(cause) && cause.name === "OAuthError" && cause.code === "invalid_grant"),
          sanitized: !line.includes(secret),
        };
      }
    }, { within: 5_000, intervalMs: 100, label: `${fault} callback diagnostic` });
    if (!diagnostic) throw new Error("Callback diagnostic missing");
    const classified = diagnostic.classified && !diagnostic.missingAuthorizationId
      && (resourceStatus !== undefined || diagnostic.sdkInvalidGrant);
    evidence.recordAssertionEvidence(`${fault}: reports ${expectedCode} in ${expectedPhase}`,
      `Reference-matched Den diagnostic must carry HTTP ${resourceStatus ?? 400}, not a missing authorization ID; token failure must retain SDK v2 OAuthError.code=invalid_grant.`, classified);
    expect(classified).toBe(true);

    const connection = await denFetch(den.admin, `/v1/mcp-connections/${id}`, { headers });
    expect(connection.response.status).toBe(200);
    if (!isRecord(connection.body)) throw new Error("Connection missing after callback");
    const disconnected = connection.body.connected === false && connection.body.connectedForMe === false
      && connection.body.connectedAt === null && connection.body.oauthClientConfigured === true;
    evidence.recordAssertionEvidence(`${fault}: failed callback does not commit a connected credential`,
      "Connection GET reports connected=false, connectedForMe=false, connectedAt=null; the OAuth client registration remains configured.", disconnected);
    expect(disconnected).toBe(true);

    const observed = (await provider.requests()).slice(firstRequest);
    const tokenRequests = observed.filter((entry) => entry.path === "/token");
    const attempts = {
      registrations: observed.filter((entry) => entry.path === "/register").length,
      authorizations: observed.filter((entry) => entry.path === "/authorize" || entry.path === "/approve").length,
      exchanges: tokenRequests.filter((entry) => entry.grantType === "authorization_code").length,
      refreshes: tokenRequests.filter((entry) => entry.grantType === "refresh_token").length,
      tokenRequests: tokenRequests.length,
    };
    const expectedExchanges = fault === "token-400" ? 2 : 1;
    const bounded = attempts.registrations === 1 && attempts.authorizations === 1
      && attempts.exchanges === expectedExchanges && attempts.refreshes === 0 && attempts.tokenRequests === expectedExchanges;
    evidence.recordAssertionEvidence(`${fault}: bounded code exchange without interactive restart or refresh`,
      `${JSON.stringify(attempts)}; ${fault === "token-400" ? "One SDK token-exchange retry is expected" : "Resource rejection must not retry the code exchange"}; no additional registration, interactive authorization, or refresh.`, bounded);
    expect(bounded).toBe(true);
    const exchange = tokenRequests[0];
    if (!exchange) throw new Error("Code exchange witness missing");
    const resources = observed.slice(before.length - firstRequest).filter((entry) => entry.path === "/mcp");
    const providerRejected = resourceStatus === undefined
      ? tokenRequests.every((entry) => entry.status === 400 && entry.oauthError === "invalid_grant"
        && entry.tokenId === undefined) && resources.length === 0
      : exchange.status === 200 && exchange.refreshTokenIssued === false
        && typeof exchange.tokenId === "string" && resources.length > 0
        && resources.every((entry) => entry.tokenId === exchange.tokenId && entry.status === resourceStatus
          && entry.oauthError === (resourceStatus === 403 ? "insufficient_scope" : "invalid_token"));
    evidence.recordAssertionEvidence(`${fault}: provider witnesses the actual rejection`,
      resourceStatus === undefined
        ? "Both code-exchange responses returned HTTP 400 invalid_grant; neither issued a candidate and no resource validation request followed."
        : `Code exchange returned HTTP 200 without a refresh token; ${resources.length} resource requests used the issued candidate fingerprint and all returned HTTP ${resourceStatus}; none succeeded.`, providerRejected);
    expect(providerRejected).toBe(true);

    const sanitized = diagnostic.sanitized && !html.includes(secret) && !connection.text.includes(secret)
      && !html.includes("mock-access-") && !html.includes("mock-refresh-")
      && !html.includes(callback.href) && !html.includes(callback.searchParams.get("state")!);
    evidence.recordAssertionEvidence(`${fault}: failure output excludes credentials and callback state`,
      "Callback HTML, connection JSON, and the reference-matched diagnostic exclude the synthetic secret. HTML excludes token prefixes and the full callback/state; evidence retains only counts and booleans.", sanitized);
    expect(sanitized).toBe(true);
  }
});
