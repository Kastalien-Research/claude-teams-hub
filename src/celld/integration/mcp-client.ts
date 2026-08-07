/**
 * Minimal Streamable-HTTP MCP client for the celld integration tier and the
 * canary CLI. Talks to the hub's /mcp endpoint (enableJsonResponse: true, so
 * every response is plain JSON). One instance = one MCP session — the race
 * gate needs two genuinely independent sessions.
 */

export interface CodeModeResult {
  result?: unknown;
  error?: string;
  logs?: string[];
}

export class McpSession {
  private readonly baseUrl: string;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    const sid = response.headers.get('mcp-session-id');
    if (sid !== null) this.sessionId = sid;
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined) throw new Error(`MCP ${method} failed: ${body.error.message ?? 'unknown'}`);
    return body.result;
  }

  async initialize(clientName: string): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.1' },
    });
    // notifications/initialized completes the handshake; no response expected.
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
    await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  /**
   * Runs a Code Mode submission through thoughtbox_execute and returns the
   * parsed CodeModeResult. `code` must evaluate to a function.
   */
  async execute(code: string): Promise<CodeModeResult> {
    const result = (await this.rpc('tools/call', {
      name: 'thoughtbox_execute',
      arguments: { code },
    })) as { content?: Array<{ type: string; text?: string }> };
    const text = result.content?.find(entry => entry.type === 'text')?.text;
    if (text === undefined) throw new Error('thoughtbox_execute returned no text content');
    return JSON.parse(text) as CodeModeResult;
  }

  /** Convenience: execute one tb.hub call with args, returning result or throwing the sandbox error. */
  async hub(method: string, args: Record<string, unknown>): Promise<unknown> {
    const outcome = await this.execute(`async () => await tb.hub.${method}(${JSON.stringify(args)})`);
    if (outcome.error !== undefined) {
      const error = new Error(outcome.error);
      const match = /^\[([A-Z_]+)\]/.exec(outcome.error);
      if (match !== null) (error as Error & { code?: string }).code = match[1] as string;
      throw error;
    }
    return outcome.result;
  }
}
