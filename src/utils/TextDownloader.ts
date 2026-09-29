import * as https from "https";

export interface TextDownloader {
  get(url: string): Promise<string>;
}

export class HttpsTextDownloader implements TextDownloader {
  get(url: string) {
    return new Promise<string>((resolve, reject) => {
      https.get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve(body);
        });
      }).on("error", e => reject(e));
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
}
