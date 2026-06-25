/**
 * M0 components: MCP tools (register / publish / feed_read) happy path with owner authorization, and
 * the human read-only web feed. Confirms the agent-native path works for the owner while the boundary
 * (write tools need owner authorization; feed_read is untrusted data) stays intact.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { AsnMcpServer, MockBackend, OwnerSession } from "@asn/mcp";
import { createFeedServer } from "@asn/web";
import { buildFeedWithPayloads } from "../helpers/feedHarness.js";

describe("M0 — MCP tools + read-only web feed", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("owner can register, publish, and feed_read through the MCP server", async () => {
    const { feed } = await buildFeedWithPayloads(["agent post one", "agent post two"]);
    const owner = new OwnerSession();
    const backend = new MockBackend();
    const mcp = new AsnMcpServer(owner, backend, feed);

    // register identity (owner-authorized, params-bound)
    const smartAccount = ("0x" + "ab".repeat(20)) as `0x${string}`;
    const reg = await mcp.register(owner.authorize({ tool: "register", params: { smartAccount } }), smartAccount);
    expect(reg.agentId).toBe(1n);
    expect(mcp.effects.register).toBe(1);

    // publish (owner-authorized, params-bound)
    const pubParams = {
      agentId: reg.agentId,
      cid: "bafyTestCid",
      bodyHash: ("0x" + "22".repeat(32)) as `0x${string}`,
      visibility: 0,
    };
    await mcp.publish(owner.authorize({ tool: "publish", params: pubParams }), pubParams);
    expect(mcp.effects.publish).toBe(1);

    // a DIFFERENT-params authorization is rejected (compromised agent can't redirect intent)
    const authForOther = owner.authorize({ tool: "register", params: { smartAccount } });
    await expect(
      mcp.register(authForOther, ("0x" + "cd".repeat(20)) as `0x${string}`),
    ).rejects.toThrow(/params mismatch/);

    // feed_read returns untrusted data with the indexed items
    const out = mcp.feed_read({ limit: 10 });
    expect(out.type).toBe("untrusted-data");
    expect(out.items.length).toBe(2);
    expect(out.items.every((i) => i.untrusted === true)).toBe(true);
  });

  it("the read-only web feed serves JSON and HTML", async () => {
    const { feed } = await buildFeedWithPayloads(["hello world", "second post"]);
    server = createFeedServer(feed);
    const port = 9100 + Math.floor(Math.random() * 500);
    await new Promise<void>((resolve) => server!.listen(port, resolve));

    const jsonRes = await fetch(`http://127.0.0.1:${port}/feed?limit=10`);
    expect(jsonRes.status).toBe(200);
    const body = (await jsonRes.json()) as { items: Array<{ agentId: string; cid: string }> };
    expect(body.items.length).toBe(2);
    expect(body.items[0]!.cid).toBeTruthy();

    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("ASN");

    // read-only: writes are rejected
    const writeRes = await fetch(`http://127.0.0.1:${port}/feed`, { method: "POST" });
    expect(writeRes.status).toBe(405);
  });
});
