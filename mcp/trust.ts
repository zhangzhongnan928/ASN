/**
 * MCP trust boundary (spec v0.3 §10, docs/ASSUMPTIONS.md §A6).
 *
 * Core idea: capability changes / state writes require an unforgeable OwnerAuthorization that is
 * minted ONLY by the owner's trusted session (an object-capability). Feed content travels on a
 * separate data path that has no reference to the owner session, so no feed content — in any
 * encoding or language — can mint an authorization. This makes prompt injection (AT-5/AT-7)
 * structurally unable to cause a write, regardless of how the LLM "interprets" the content.
 */
import { randomBytes } from "@noble/hashes/utils";
import { bytesToHex } from "@asn/shared";

export type ToolName =
  | "register"
  | "publish"
  | "feed_read"
  | "grant_capability"
  | "revoke_capability";

export interface ActionIntent {
  tool: ToolName;
  params: Record<string, unknown>;
}

export interface OwnerAuthorization {
  sessionId: string;
  nonce: string;
  intent: ActionIntent;
}

export class TrustBoundaryError extends Error {}

/** Stable serialization (sorted keys, bigint-safe) so authorization params can be compared exactly. */
export function canonicalParams(p: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return `bigint:${v.toString()}`;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = norm((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(p ?? {}));
}

/**
 * The owner's trusted instruction channel. The ONLY minter of authorizations. Nonces are random,
 * single-use, and never leave the owner's control, so a forged/copied authorization is rejected.
 */
export class OwnerSession {
  readonly id: string;
  private readonly issued = new Set<string>();

  constructor() {
    this.id = bytesToHex(randomBytes(16));
  }

  /** Owner explicitly authorizes a single write action. */
  authorize(intent: ActionIntent): OwnerAuthorization {
    const nonce = bytesToHex(randomBytes(32));
    this.issued.add(nonce);
    return { sessionId: this.id, nonce, intent };
  }

  /** Verify + consume (single-use). Authorization must match this session, an issued nonce, the exact
   *  intended tool, AND the exact parameters — so a compromised agent cannot redirect an owner's
   *  authorization to different params (e.g. a different grantee). */
  consume(auth: OwnerAuthorization, expectedTool: ToolName, actualParams: Record<string, unknown>): void {
    if (!auth || typeof auth !== "object") throw new TrustBoundaryError("missing authorization");
    if (auth.sessionId !== this.id) throw new TrustBoundaryError("authorization from foreign/forged session");
    if (!this.issued.has(auth.nonce)) throw new TrustBoundaryError("unknown/forged authorization nonce");
    if (auth.intent?.tool !== expectedTool) throw new TrustBoundaryError("authorization tool mismatch");
    if (canonicalParams(auth.intent?.params) !== canonicalParams(actualParams)) {
      throw new TrustBoundaryError("authorization params mismatch");
    }
    this.issued.delete(auth.nonce); // single-use: defeats replay
  }
}
