import type { RacyCacheTextDownloader } from "./TextDownloader";

/**
 * Downloads and parses the config schema.
 *
 * Fails when the downloaded text is not a JSON object, in which case the text
 * is removed from the cache so that it's downloaded again the next time.
 */
export async function downloadConfigSchema(
  downloader: RacyCacheTextDownloader,
  url: string,
): Promise<{ [key: string]: any }> {
  const text = await downloader.get(url);
  try {
    const schema: unknown = JSON.parse(text);
    if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`Expected the config schema to be an object, but found: ${text.substring(0, 100)}`);
    }
    return schema;
  } catch (err) {
    // ex. the page of a captive portal, which would otherwise be used for the rest of the session
    downloader.forget(url);
    throw err;
  }
}
