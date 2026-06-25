/**
 * AT-8 — indexer must stay consistent across a chain reorg, and must never index an entry whose
 * CID/hash does not verify. (adversarial-test-spec AT-8, spec §8.)
 *
 * "Attack succeeds" (test FAILS) iff after a reorg the feed shows a ghost (orphaned) entry, omits a
 * now-canonical entry, or admits a forged (hash-mismatched / unavailable) entry.
 */
import { describe, it, expect } from "vitest";
import { keccak256, utf8, type Hex } from "@asn/shared";
import { computeCID, bodyHash as hashBody, cidDigest as digestOfCid } from "@asn/encryption";
import { Indexer, FeedApi, MockChainSource, InMemoryContentStore, type PublicationEvent } from "@asn/indexer";

type RawEvent = Omit<PublicationEvent, "blockNumber" | "blockHash" | "logIndex">;
const OWNER = ("0x" + "11".repeat(20)) as Hex;

async function validEvent(
  store: InMemoryContentStore,
  agentId: bigint,
  pubId: bigint,
  text: string,
  kind: "Published" | "Updated" = "Published",
  revision = 1,
): Promise<RawEvent> {
  const bytes = utf8(text);
  const cid = await computeCID(bytes);
  store.put(cid, bytes);
  return {
    kind,
    agentId,
    pubId,
    cid,
    cidDigest: digestOfCid(cid),
    bodyHash: hashBody(bytes),
    revision,
    keyEpoch: 0,
    visibility: 0,
    owner: OWNER,
  };
}

/** A forged event: announces a cid whose content does NOT hash to bodyHash. */
async function forgedEvent(store: InMemoryContentStore, agentId: bigint, pubId: bigint): Promise<RawEvent> {
  const real = utf8("real content");
  const cid = await computeCID(real);
  store.put(cid, real);
  return {
    kind: "Published",
    agentId,
    pubId,
    cid,
    cidDigest: digestOfCid(cid),
    bodyHash: keccak256(utf8("a different body that was never stored")), // mismatch!
    revision: 1,
    keyEpoch: 0,
    visibility: 0,
    owner: OWNER,
  };
}

function keys(api: FeedApi): string[] {
  return api.getFeed({ limit: 200 }).items.map((i) => `${i.agentId}:${i.pubId}`);
}

describe("AT-8 reorg + CID validation", () => {
  it("removes orphaned entries, adds canonical ones, rejects forged entries", async () => {
    const chain = new MockChainSource();
    const store = new InMemoryContentStore();
    const indexer = new Indexer(chain, store);
    const api = new FeedApi(indexer);

    // Build chain: b1=A, b2=B, b3=forged.
    chain.addBlock([await validEvent(store, 1n, 1n, "A post")]);
    chain.addBlock([await validEvent(store, 2n, 1n, "B post")]);
    chain.addBlock([await forgedEvent(store, 99n, 1n)]);
    await indexer.sync();

    expect(keys(api).sort()).toEqual(["1:1", "2:1"]); // forged 99:1 NOT indexed
    expect(indexer.headCursor).toBe(3n);

    // ── reorg: drop b2 + b3, replace with b2'=C and b3'=(A revision 2 update).
    chain.reorg(2, [
      [await validEvent(store, 3n, 1n, "C post")],
      [await validEvent(store, 1n, 1n, "A post v2", "Updated", 2)],
    ]);
    await indexer.sync();

    const after = keys(api).sort();
    expect(after).toEqual(["1:1", "3:1"]); // A survived, C is new
    expect(after).not.toContain("2:1"); // B orphaned (ghost removed)
    expect(after).not.toContain("99:1"); // forged orphaned too
    expect(indexer.headCursor).toBe(3n);

    // A now reflects the canonical revision 2 from the new chain.
    const a = api.getPublication(1n, 1n)!;
    expect(a.revision).toBe(2);
    expect(a.cid).toBe(await computeCID(utf8("A post v2")));
  });

  it("paginates without duplicates or gaps, including across a reorg", async () => {
    const chain = new MockChainSource();
    const store = new InMemoryContentStore();
    const indexer = new Indexer(chain, store);
    const api = new FeedApi(indexer);

    for (let i = 1; i <= 6; i++) chain.addBlock([await validEvent(store, BigInt(i), 1n, `post ${i}`)]);
    await indexer.sync();

    // page through 2 at a time, collect keys
    const collected: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page: { items: { agentId: bigint; pubId: bigint }[]; nextCursor: string | null } = api.getFeed({
        limit: 2,
        ...(cursor ? { before: cursor } : {}),
      });
      collected.push(...page.items.map((i) => `${i.agentId}:${i.pubId}`));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(collected).size).toBe(collected.length); // no duplicates
    expect(collected.sort()).toEqual(["1:1", "2:1", "3:1", "4:1", "5:1", "6:1"]); // no gaps

    // reorg away the top two blocks, re-sync, ensure no ghost in pagination
    chain.reorg(2, [[await validEvent(store, 7n, 1n, "post 7")]]);
    await indexer.sync();
    const all = keys(api).sort();
    expect(all).toEqual(["1:1", "2:1", "3:1", "4:1", "7:1"]); // 5:1 and 6:1 gone, 7:1 added
  });
});
