import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.MOCK_SHUTTER_PORT ?? 9100);
const capabilityKeys = JSON.parse(process.env.SHUTTER_CAPABILITY_KEYS ?? "{}") as Record<
  string,
  unknown
>;
const spaceId = process.env.SHUTTER_SPACE_ID ?? "pane-view";
const kid = process.env.SHUTTER_CAPABILITY_KID ?? "demo-key";

function readKeyMaterial(): Uint8Array {
  const spaceKeys = capabilityKeys[spaceId];
  const encoded =
    spaceKeys &&
    typeof spaceKeys === "object" &&
    !Array.isArray(spaceKeys) &&
    typeof (spaceKeys as Record<string, unknown>)[kid] === "string"
      ? ((spaceKeys as Record<string, string>)[kid] as string)
      : typeof capabilityKeys[kid] === "string"
        ? (capabilityKeys[kid] as string)
        : undefined;
  if (!encoded) {
    throw new Error("Shutter capability key is not configured for mock edge");
  }
  const key = Uint8Array.from(Buffer.from(encoded, "base64url"));
  if (key.byteLength !== 32) {
    throw new Error("Shutter capability key must be 32 bytes");
  }
  return key;
}

function frameStrings(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const output = new Uint8Array(encoded.reduce((sum, value) => sum + value.byteLength + 4, 0));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of encoded) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

async function decryptCapability(token: string): Promise<Record<string, unknown>> {
  const [version, tokenKid, ivEncoded, ciphertextEncoded] = token.split(".");
  if (version !== "v1" || tokenKid !== kid || !ivEncoded || !ciphertextEncoded) {
    throw new Error("Unsupported capability token");
  }

  const key = await crypto.subtle.importKey("raw", readKeyMaterial(), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(Buffer.from(ivEncoded, "base64url")),
      additionalData: frameStrings(["v1", spaceId, kid, "image_source"]),
      tagLength: 128,
    },
    key,
    Uint8Array.from(Buffer.from(ciphertextEncoded, "base64url")),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
      const match = url.pathname.match(/^\/v1\/private\/[^/]+\/source\/(.+)$/u);
      if (!match || request.method !== "GET") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const claims = await decryptCapability(decodeURIComponent(match[1] ?? ""));
      const locator = claims.locator;
      if (typeof locator !== "string" || locator.length === 0) {
        throw new Error("Capability is missing a source locator");
      }

      const upstream = await fetch(locator);
      if (!upstream.ok || !upstream.body) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "upstream_failed", status: upstream.status }));
        return;
      }

      response.writeHead(200, {
        "cache-control": "private, max-age=300",
        "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      });
      const reader = upstream.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        response.write(chunk.value);
      }
      response.end();
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "invalid_capability",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock shutter edge listening on http://127.0.0.1:${PORT}`);
});
