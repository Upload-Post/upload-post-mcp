import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import UploadPost from "upload-post";

export const PACKAGE_VERSION = "0.1.1";
export const DEFAULT_BASE_URL = "https://api.upload-post.com/api";

export interface UploadPostMcpClientOptions {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Single facade used by every MCP tool.
 *
 * - `sdk` — the official `upload-post` npm SDK (typed methods for ~28 endpoints).
 * - `http` — pre-configured axios instance for the ~20 endpoints not yet exposed
 *   by the SDK (DMs, autodms, teams, queue, retry, FFmpeg jobs, status page,
 *   AI rewrite, Reddit metadata, growth snapshots, …).
 *
 * The MCP layer never reaches Upload-Post by any other route.
 */
export class UploadPostMcpClient {
  readonly sdk: UploadPost;
  readonly http: AxiosInstance;
  readonly baseUrl: string;

  constructor(opts: UploadPostMcpClientOptions) {
    if (!opts.apiKey) {
      throw new Error(
        "UPLOAD_POST_API_KEY is required. Get one at https://app.upload-post.com"
      );
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.sdk = new UploadPost(opts.apiKey);
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Apikey ${opts.apiKey}`,
        "X-Upload-Post-Source": `mcp/${PACKAGE_VERSION}`,
      },
      timeout: 120_000,
      validateStatus: () => true,
    });
  }

  /** Thin wrapper that surfaces non-2xx as Errors carrying the API payload. */
  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
    path: string,
    options: { body?: unknown; query?: Record<string, unknown> } = {}
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url: path,
      params: options.query,
      data: options.body,
    };
    const res = await this.http.request<T>(config);
    if (res.status < 200 || res.status >= 300) {
      const body =
        typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      throw new Error(
        `Upload-Post API ${method} ${path} failed (${res.status}): ${body}`
      );
    }
    return res.data;
  }
}

/** Strip undefined keys so we don't send `?foo=undefined` upstream. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
