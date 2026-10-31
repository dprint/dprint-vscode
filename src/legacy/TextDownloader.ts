import type * as http from "http";
import * as https from "https";

export interface TextDownloader {
  get(url: string): Promise<string>;
}

/** Function that starts a GET request (ex. `https.get`). */
export type TextDownloaderRequest = (
  url: string,
  callback: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

export interface HttpsTextDownloaderOptions {
  /** How long the whole download may take before it fails. */
  timeoutMs?: number;
  /** Starts the request. Defaults to `https.get` and only exists for testing. */
  request?: TextDownloaderRequest;
}

/**
 * Downloads text over https.
 *
 * Only resolves for a complete response with a successful status code.
 * A few redirects are followed as long as they don't change the protocol.
 */
export class HttpsTextDownloader implements TextDownloader {
  #timeoutMs: number;
  #request: TextDownloaderRequest;

  constructor(options: HttpsTextDownloaderOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#request = options.request ?? https.get;
  }

  get(url: string) {
    return new Promise<string>((resolve, reject) => {
      const timeoutMs = this.#timeoutMs;
      let settled = false;
      const succeed = (body: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(body);
        }
      };
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      };

      let currentReq: http.ClientRequest;
      const startRequest = (requestUrl: string, redirectCount: number) => {
        const req = this.#request(requestUrl, (res) => {
          const statusCode = res.statusCode;
          const location = res.headers.location;
          if (statusCode != null && REDIRECT_STATUS_CODES.has(statusCode) && location != null) {
            try {
              if (redirectCount >= MAX_REDIRECTS) {
                throw new Error(`Failed downloading ${url} (too many redirects).`);
              }
              startRequest(getRedirectUrl(requestUrl, location), redirectCount + 1);
            } catch (err) {
              fail(err);
            }
            req.destroy();
            return;
          }
          if (statusCode == null || statusCode < 200 || statusCode >= 300) {
            fail(new Error(`Failed downloading ${requestUrl} (status code ${statusCode}).`));
            // nothing is going to read the body, so stop receiving it
            req.destroy();
            return;
          }

          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            if (res.complete) {
              succeed(body);
            } else {
              fail(new Error(`Failed downloading ${requestUrl} (the response was incomplete).`));
            }
          });
          res.on("error", fail);
          // in case the connection is lost without an error being emitted
          res.on("close", () => fail(new Error(`Failed downloading ${requestUrl} (the connection was closed).`)));
        });
        currentReq = req;
        // this is also what prevents an error after the request is destroyed from being unhandled
        req.on("error", err => {
          // a request that was redirected is destroyed, which is not a failure
          if (req === currentReq) {
            fail(err);
          }
        });
      };

      // limits the whole download rather than the time between chunks so that
      // a response that trickles in can't keep this pending
      const timeout = setTimeout(() => {
        fail(new Error(`Timed out after ${timeoutMs}ms downloading ${url}.`));
        currentReq.destroy();
      }, timeoutMs);

      try {
        startRequest(url, 0);
      } catch (err) {
        fail(err);
      }
    });
  }
}

/** A racy cache that downloads text. */
export class RacyCacheTextDownloader implements TextDownloader {
  #cache: Map<string, string> = new Map();
  #inner: TextDownloader;

  constructor(inner: TextDownloader) {
    this.#inner = inner;
  }

  async get(url: string): Promise<string> {
    // For this cache, we don't care about two of the same
    // requests racing for the response as the response should
    // be the same.
    let text = this.#cache.get(url);

    if (text == null) {
      // store an immutable snapshot
      text = await this.#inner.get(url);
      this.#cache.set(url, text);
    }

    return text;
  }

  /** Removes a cached text so that it's downloaded again the next time it's requested. */
  forget(url: string) {
    this.#cache.delete(url);
  }
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Gets the url to request for a redirect, which may not change the protocol (ex. from https to http). */
function getRedirectUrl(url: string, location: string) {
  const fromUrl = new URL(url);
  const redirectUrl = new URL(location, fromUrl);
  if (redirectUrl.protocol !== fromUrl.protocol) {
    throw new Error(`Failed downloading ${url} (redirected to another protocol: ${redirectUrl.protocol}).`);
  }
  return redirectUrl.href;
}
