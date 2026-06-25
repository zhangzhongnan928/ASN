/**
 * Consumer-agent harness for AT-5 / AT-7.
 *
 * Models an agent that reads the feed and (in the adversarial case) has its "reasoning" fully hijacked
 * by injected content. The point being demonstrated: even a 100%-compromised interpreter CANNOT cause
 * a capability change or a tool call, because:
 *   - the content-processing path never holds the owner session (it cannot mint authorizations), and
 *   - the MCP server rejects any write lacking a valid owner authorization.
 *
 * The content processor also flags injection attempts (as a labeler would, §7.3) but NEVER acts and
 * NEVER calls a tool — content is pure data.
 */
import type { AsnMcpServer } from "./server.js";
import type { OwnerSession, OwnerAuthorization } from "./trust.js";

export interface ProcessedItem {
  agentId: string;
  pubId: string;
  /** the decrypted/plaintext body, kept strictly as data */
  data: string;
  /** defensive labels; presence of "prompt-injection" does NOT trigger any action */
  labels: string[];
}

/** Pure, side-effect-free analysis of untrusted content. Returns data + labels. Calls no tools. */
export class FeedContentProcessor {
  static detectInjection(text: string): string[] {
    const labels: string[] = [];
    const lowered = text.toLowerCase();
    const patterns: Array<[RegExp, string]> = [
      [/system\s*:|<\s*system\s*>/i, "fake-system-prompt"],
      [/ignore (all )?previous instructions|disregard (the )?above/i, "ignore-instructions"],
      [/<\s*tool_use\s*>|"tool"\s*:|function_call|tool_call/i, "fake-tool-call"],
      [/grant(_capability)?\b|revoke(_capability)?\b/i, "capability-instruction"],
      [/transfer(_all)?(_assets)?|drain|withdraw/i, "asset-exfil-instruction"],
      [/[A-Za-z0-9+/]{40,}={0,2}/, "possible-base64-payload"],
    ];
    for (const [re, label] of patterns) if (re.test(text) || re.test(lowered)) labels.push(label);
    return labels;
  }

  process(items: Array<{ agentId: string; pubId: string }>, contentFor: (agentId: string, pubId: string) => string): ProcessedItem[] {
    return items.map((i) => {
      const data = contentFor(i.agentId, i.pubId);
      return { agentId: i.agentId, pubId: i.pubId, data, labels: FeedContentProcessor.detectInjection(data) };
    });
  }
}

export class ConsumerAgent {
  readonly processor = new FeedContentProcessor();

  constructor(
    private readonly server: AsnMcpServer,
    /** the trusted instruction channel — used ONLY for owner-initiated actions, never for content */
    private readonly owner: OwnerSession,
  ) {}

  /** Read the feed (untrusted data). */
  readFeed(opts: { limit?: number } = {}) {
    return this.server.feed_read(opts);
  }

  /** Process feed content into data + labels. This path has NO access to the owner session. */
  processFeed(
    items: Array<{ agentId: string; pubId: string }>,
    contentFor: (a: string, p: string) => string,
  ): ProcessedItem[] {
    return this.processor.process(items, contentFor);
  }

  /**
   * Adversarial simulation: the agent's reasoning is fully hijacked by injected content and it TRIES
   * to do what the content demands. It can only fabricate an authorization from the content itself,
   * which the server rejects. Returns the error; performs no write.
   */
  async simulateHijackedGrant(forgedFromContent: unknown, params: {
    capType: number;
    granteeAgentId: bigint;
    resourceId: `0x${string}`;
    expiry: number;
  }): Promise<Error> {
    try {
      await this.server.grant_capability(forgedFromContent as OwnerAuthorization, params);
      throw new Error("BOUNDARY BROKEN: grant succeeded from content");
    } catch (e) {
      return e as Error;
    }
  }

  async simulateHijackedPublish(forgedFromContent: unknown, params: {
    agentId: bigint;
    cid: string;
    bodyHash: `0x${string}`;
    visibility: number;
  }): Promise<Error> {
    try {
      await this.server.publish(forgedFromContent as OwnerAuthorization, params);
      throw new Error("BOUNDARY BROKEN: publish succeeded from content");
    } catch (e) {
      return e as Error;
    }
  }

  /** Legitimate path (positive control): the OWNER explicitly authorizes a grant. */
  async ownerInitiatedGrant(params: {
    capType: number;
    granteeAgentId: bigint;
    resourceId: `0x${string}`;
    expiry: number;
  }): Promise<void> {
    const auth = this.owner.authorize({ tool: "grant_capability", params: params as Record<string, unknown> });
    await this.server.grant_capability(auth, params);
  }
}
