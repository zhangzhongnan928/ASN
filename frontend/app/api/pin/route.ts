// Server-side IPFS pin (keeps the Pinata key secret — never exposed to the browser).
// POST { text } -> { cid }. Returns 501 if PINATA_JWT is not configured (publish falls back to
// anchor-only). The pinned bytes are exactly the UTF-8 of `text`, so keccak256(text) == on-chain
// bodyHash and the gateway returns the same bytes.
export const runtime = "nodejs";

export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return Response.json({ error: "pinning not configured (set PINATA_JWT)" }, { status: 501 });
  }
  let text: unknown;
  try {
    ({ text } = await req.json());
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof text !== "string" || text.length === 0) {
    return Response.json({ error: "empty text" }, { status: 400 });
  }
  if (text.length > 100_000) {
    return Response.json({ error: "text too large" }, { status: 413 });
  }

  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "asn-post.txt");
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  form.append("pinataMetadata", JSON.stringify({ name: "asn-post" }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    return Response.json({ error: `pinata ${res.status}: ${body.slice(0, 200)}` }, { status: 502 });
  }
  const data = (await res.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) return Response.json({ error: "no cid from pinata" }, { status: 502 });
  return Response.json({ cid: data.IpfsHash });
}
