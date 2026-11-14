import { hideInvisible, messageText, redact, untrusted } from './text.ts';

// Errors a tool hands back to the model. The message is read by the model, so it says what went
// wrong and what to do next.

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** An error answer from the Ethereum JSON-RPC (the node understood the request and refused it). */
export class EthRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'EthRpcError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/**
 * Turns anything thrown inside a tool into the text the model will read. Every branch goes through
 * redact(): a message can quote an endpoint set by hand, and with it a key in its path or query.
 */
export function failureText(toolName: string, err: unknown): string {
  if (err instanceof ToolError) return redact(err.message);
  if (err instanceof EthRpcError) {
    // The message and the data are the node's own words, which may quote text from a contract. A
    // string is shown as one quoted string; other data as JSON, which quotes its own strings.
    const shown = typeof err.data === 'string' ? untrusted(redact(err.data), 1200) : hideInvisible(redact(JSON.stringify(err.data) ?? '')).slice(0, 1200);
    const data = err.data === undefined || err.data === null ? '' : ` Data: ${shown}.`;
    const code = Number.isSafeInteger(err.code) ? err.code : 'unknown';
    return `The Ethereum RPC refused ${err.method} with code ${code}: ${untrusted(redact(err.message), 600)}.${data} Paste this text into explain_error for the likely cause.`;
  }
  // Any other failure: a library's or the node's own message, on one line, with control and
  // invisible characters written as escapes.
  const message = messageText(err instanceof Error ? err.message : String(err), 800);
  if (/No response received from RPC endpoint|WebSocket is not connected|disconnected from|Normal Closure|Abnormal Closure/i.test(message)) {
    return `The node did not answer (${message}). The public Portaldot nodes are run by one operator and the testnet has stopped before, so this is probably not a fault in your code. Try again in a moment; get_chain_facts shows whether the chain is moving.`;
  }
  return `${toolName} failed: ${message}`;
}
