export interface WebPage {
  url: string;
  title: string;
  content: string;
}

export interface WebFetchClient {
  fetchPage(url: string, signal?: AbortSignal): Promise<WebPage>;
}

export interface HttpWebFetchClientOptions {
  timeoutMs?: number;
  /** Hard stop on bytes read from the wire, so a hostile or endless response cannot run away. */
  maxBytes?: number;
  /** Hard stop on characters handed to the model, so one page cannot dominate the context window. */
  maxChars?: number;
}

const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|.*\+json))/i;

/**
 * Reject anything that is not a plain, credential-free https URL.
 *
 * This is hygiene rather than a security boundary. The exposure `web_fetch` adds is prompt
 * injection — untrusted page text aimed at the model — and no amount of address filtering touches
 * that; it is handled by framing and instruction instead (ADR 005). What this does buy is a clear
 * error for the model when it invents a malformed or non-web URL.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs can be fetched, got "${url.protocol}//".`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URLs carrying credentials are not fetched.");
  }
  return url;
}

/** Reduce HTML to readable text. Crude on purpose — the model reads prose, not markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] === undefined ? "" : htmlToText(match[1]).slice(0, 200);
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      // Reading a stream is sequential by nature; there is nothing to parallelise here.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer.subarray(0, maxBytes));
}

export class HttpWebFetchClient implements WebFetchClient {
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxChars: number;

  constructor(options: HttpWebFetchClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 2_000_000;
    this.#maxChars = options.maxChars ?? 24_000;
  }

  async fetchPage(raw: string, signal?: AbortSignal): Promise<WebPage> {
    const url = assertFetchableUrl(raw);
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    const response = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      redirect: "follow",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
      throw new Error(`Fetching ${url.href} returned ${response.status} ${response.statusText}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType !== "" && !TEXTUAL.test(contentType)) {
      throw new Error(`${url.href} is ${contentType}, which cannot be read as text.`);
    }

    const body = await readCapped(response, this.#maxBytes);
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body);
    const text = isHtml ? htmlToText(body) : body.trim();

    return {
      url: response.url === "" ? url.href : response.url,
      title: isHtml ? extractTitle(body) : "",
      content: text.slice(0, this.#maxChars),
    };
  }
}
