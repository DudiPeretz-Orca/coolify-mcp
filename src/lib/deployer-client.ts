/**
 * HTTP client for the artifact deployer service.
 * Lets a claude.ai session push a large HTML page as raw-text parts, so the
 * model never has to base64-encode it.
 */

const TIMEOUT_MS = 120_000;

export class DeployerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  begin(body: { name: string; owner: string; mode: 'create' | 'update' }): Promise<unknown> {
    return this.request('POST', '/v1/uploads', body);
  }

  append(
    uploadId: string,
    body: { path: string; index: number; total: number; text: string },
  ): Promise<unknown> {
    return this.request('PUT', `/v1/uploads/${encodeURIComponent(uploadId)}/parts`, body);
  }

  commit(uploadId: string): Promise<unknown> {
    return this.request('POST', `/v1/uploads/${encodeURIComponent(uploadId)}/commit`, {});
  }

  status(deploymentUuid: string): Promise<unknown> {
    return this.request('GET', `/v1/deployments/${encodeURIComponent(deploymentUuid)}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`deployer unreachable at ${this.baseUrl}: ${reason}`, { cause: error });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      // Deployer errors are {"error": code, "message": message}; surface verbatim.
      const err = parsed as { error?: unknown; message?: unknown } | undefined;
      if (err && typeof err.error === 'string' && typeof err.message === 'string') {
        throw new Error(`${err.error}: ${err.message}`);
      }
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (parsed === undefined) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return parsed;
  }
}
