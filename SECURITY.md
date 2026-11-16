# Security

## What the server does and does not do

The chain tools of the Portaldot Builder Kit are an MCP server that only reads.

- No tool asks for a private key or a secret recovery phrase, and the server has no way to sign or send a transaction. The most a tool returns is unsigned call data, for you to sign in your own wallet or script.
- A secret recovery phrase in any argument of any tool is refused before the tool runs and before anything is sent. A private key cannot be told apart from an account id (both are 0x and 64 hex characters), so never paste one: it would go to the node as a lookup.
- The server connects only to the public Portaldot endpoints, or to the endpoints you set in its environment variables, and only when a tool needs the chain. When `HTTPS_PROXY` or `HTTP_PROXY` is set and Node.js follows it, the connection goes through that proxy.
- The addresses, call data and bytecode you ask about are sent to those nodes. Nothing is sent to us, and there is no telemetry.
- It writes no files. One tool, `simulate_contract_deploy`, reads a build artifact that you name, and only from inside the project folder.
- Text that comes from the chain, such as a revert message, is shown as one quoted string, so that it is read as data and not as instructions.

When npx or npm fetches the server, npm itself also contacts the npm registry: in the starts with npx that we traced on Nov 16, 2026, npm 11.6.2 sent the package's name and version to the registry's audit service. That is npm's behaviour, not the server's.

## Supported versions

Fixes go into the newest version only.

## Reporting a problem

Please report a security problem privately: open the repository on GitHub, choose the Security tab, then "Report a vulnerability". Do not open a public issue for it. Say what you saw, which version you used (the server reports it when it starts), and the steps that show the problem. We answer in that report.

Other problems, such as a fact that is wrong or out of date, go to the issues of the repository.
