// Thin Meta Model API client. The Worker only moves bytes: images go in as data URLs or URLs
// and come back as short-lived URLs (response_format: "url"), so nothing large is decoded here.
import { IMAGE_MODEL, META_BASE_URL, SAM_MODEL } from "../config";

export class ContentFilteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentFilteredError";
  }
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function call(apiKey: string, path: string, body: unknown, timeoutMs = 90_000): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${META_BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 400 && text.includes("content_policy_violation")) throw new ContentFilteredError(text);
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 500));
      continue;
    }
    throw new MetaApiError(`${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
}

type ImagesResponse = { data: { url?: string }[] };

function firstUrl(r: unknown): string {
  const url = (r as ImagesResponse).data?.[0]?.url;
  if (!url) throw new MetaApiError("image response without url", 502);
  return url;
}

/** Edit one or more input images (the first is the scene). Returns a temporary signed URL. */
export async function editImage(
  apiKey: string,
  opts: { prompt: string; images: string[]; size: string },
): Promise<string> {
  const body = {
    model: IMAGE_MODEL,
    prompt: opts.prompt,
    n: 1,
    size: opts.size,
    response_format: "url",
    images: opts.images.map((image_url) => ({ image_url })),
  };
  try {
    return firstUrl(await call(apiKey, "/images/edits", body));
  } catch (err) {
    // The content filter is not deterministic: the same prompt and image can pass a second time (spike, 2026-10-26).
    if (err instanceof ContentFilteredError) return firstUrl(await call(apiKey, "/images/edits", body));
    throw err;
  }
}

export async function generateImage(apiKey: string, opts: { prompt: string; size: string }): Promise<string> {
  const body = { model: IMAGE_MODEL, prompt: opts.prompt, n: 1, size: opts.size, response_format: "url" };
  try {
    return firstUrl(await call(apiKey, "/images/generations", body));
  } catch (err) {
    if (err instanceof ContentFilteredError) return firstUrl(await call(apiKey, "/images/generations", body));
    throw err;
  }
}

type ResponsesResult = { output_text?: string; output?: { content?: { type: string; text?: string }[] }[] };

/** SAM 3.1 segmentation for one noun phrase. Returns SAM's raw text; the client decodes masks. */
export async function segment(apiKey: string, opts: { phrase: string; image: string }): Promise<string> {
  const r = (await call(
    apiKey,
    "/responses",
    {
      model: SAM_MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: opts.phrase },
            { type: "input_image", image_url: opts.image },
          ],
        },
      ],
      metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    },
    60_000,
  )) as ResponsesResult;
  if (typeof r.output_text === "string") return r.output_text;
  return (r.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("");
}
