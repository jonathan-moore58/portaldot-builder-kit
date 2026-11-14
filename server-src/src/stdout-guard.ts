// Import this FIRST in the entry point. ES modules run in import order, so this runs before
// any dependency's top-level code. Its only imports are a Node built-in and text.ts, which has none.
//
// stdout is the MCP protocol channel: one JSON-RPC message per line. Anything else written there
// corrupts the stream. The logger inside @polkadot/util sends .log() and .debug() to console.log,
// which is stdout (it fires, for example, when the chain upgrades its runtime), so console.log,
// console.info and console.debug are sent to stderr instead, and console.error goes through redact() too.
import { format } from 'node:util';
import { redact } from './lib/text.ts';

const rawError = console.error.bind(console);

// When this server closes an idle connection itself, the library reports the closed socket as an
// error ("1000:: Normal Closure"). That is not an error, so it is kept out of the log.
// Every line goes through redact(): the library's logger prints the endpoint when a socket drops,
// and an endpoint set by hand may carry a key in its path or query.
const toStderr = (...parts: unknown[]): void => {
  const line = format(...parts);
  if (line.includes('1000:: Normal Closure')) return;
  rawError(redact(line));
};

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.error = toStderr;

export {};
