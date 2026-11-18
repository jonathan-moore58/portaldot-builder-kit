# The Portaldot Builder Kit in other coding assistants

by the Bridge Zero team

The kit's chain tools are an ordinary MCP server that runs on your computer and talks over stdio. Any coding assistant that can start such a server can use them. In Claude Code, install the plugin as the [README](../README.md#install) says; this page is for the other assistants.

> **How we know what is on this page.** Each assistant's section rests on that assistant's official documentation, as we read it on Nov 15 and 16, 2026. We have not run these assistants ourselves. What we did run: Claude Code with the plugin, up to this version; the server over stdio with our own test client; on Windows on Nov 16, 2026, starts of the server of version 0.2.1 through npx from a packed copy and from a local git copy of this repository, and from a global install; and on Nov 18, 2026, three starts of this version's server through npx from GitHub. Where the documentation is unclear, or two official pages disagree, the section says so and gives the safer choice. If your assistant behaves differently, please [open an issue](https://github.com/jonathan-moore58/portaldot-builder-kit/issues).

## Find your assistant

| Assistant | Settings file | Format |
| --- | --- | --- |
| [VS Code with GitHub Copilot](#vs-code-with-github-copilot) | `~/.copilot/mcp-config.json` or `.mcp.json` | JSON, `mcpServers` |
| [Cursor](#cursor) | `~/.cursor/mcp.json` or `.cursor/mcp.json` | JSON, `mcpServers` |
| [OpenAI Codex](#openai-codex) | `~/.codex/config.toml` | TOML, `[mcp_servers.portaldot]` |
| [Claude Desktop](#claude-desktop) | `claude_desktop_config.json` | JSON, `mcpServers` |
| [GitHub Copilot CLI](#github-copilot-cli) | `~/.copilot/mcp-config.json` or `.mcp.json` | JSON, `mcpServers` |
| [Gemini CLI](#gemini-cli) | `~/.gemini/settings.json` | JSON, `mcpServers` |
| [JetBrains AI Assistant](#jetbrains-ai-assistant) | a page in the IDE settings | JSON, `mcpServers` |
| [JetBrains Junie](#jetbrains-junie) | `~/.junie/mcp/mcp.json` or `.junie/mcp/mcp.json` | JSON, `mcpServers` |
| [Devin Desktop (formerly Windsurf)](#devin-desktop) | `~/.config/devin/mcp_config.json` or `.devin/mcp_config.json` | JSON, `mcpServers` |
| [Cline](#cline) | `cline_mcp_settings.json` | JSON, `mcpServers` |
| [Zed](#zed) | Zed's `settings.json` | JSON, `context_servers` |
| [Kiro and Kiro CLI (formerly Amazon Q Developer CLI)](#kiro-and-kiro-cli) | `~/.kiro/settings/mcp.json` or `.kiro/settings/mcp.json` | JSON, `mcpServers` |
| [opencode](#opencode) | `~/.config/opencode/opencode.json` | JSON, `mcp.servers` |
| [Goose](#goose) | Goose's `config.yaml` | YAML, `extensions` |
| [Continue](#continue) | `~/.continue/config.yaml` or `.continue/mcpServers/` | YAML, `mcpServers` list |

Not listed? See [Any other MCP client](#any-other-mcp-client). Then add the [standing instructions](#standing-instructions) to your project.

## Before you start

You need Node.js 20 or later, and git.

There are two ways to start the server. Every section below gives both, with the server named `portaldot`.

### Way A: a local copy (recommended)

Clone the repository once:

```
git clone https://github.com/jonathan-moore58/portaldot-builder-kit.git
```

Then point your assistant at this command, with the absolute path of the folder you cloned into:

```
node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs
```

The server is one built file with nothing to install. It answered in 0.3 to 1.5 seconds in our tests of version 0.3.0, on Node.js 24.12 on Windows (Nov 16, 2026). To update it, run `git pull` in that folder and restart your assistant.

### Way B: npx, nothing to clone

```
npx -y github:jonathan-moore58/portaldot-builder-kit
```

To stay on one release, add its tag: `github:jonathan-moore58/portaldot-builder-kit#v0.3.0`. Without a tag, npx starts what the main branch holds at that moment.

npm fetches the package again at every start, and that is slow. On Nov 16, 2026, on Windows, with a local git copy of this repository in place of GitHub, a start took 14 to 16 seconds once npm had the package in its cache, and 42 seconds the first time. From GitHub, three starts of this version that fetched the package anew took 38, 64 and 120 seconds on Nov 18, 2026. That is longer than some assistants wait for a server to start:

| Assistant | Documented start-up limit | Raise it with |
| --- | --- | --- |
| Codex | 10 seconds, and 1 second for the first list of tools | `startup_timeout_sec = 120` and `mcp_optional_startup_grace_ms = 0` |
| opencode | 30 seconds | `"timeout": { "startup": 120000 }` |
| Cursor | 60 seconds | `"startupTimeoutSec": 120` (at most 300) |
| Junie | 60 seconds per request, the start included | `"timeout": 120000` |
| Zed | 60 seconds | `"timeout": 120` (at most 600) |
| GitHub Copilot CLI | 30 seconds, at least 60 seconds to connect | `"timeout": 120000` |
| Gemini CLI | 600 seconds per request | not needed |
| Goose | `timeout: 300` (seconds) in its examples | not needed |
| Continue | `connectionTimeout` (no default given) | `connectionTimeout` |
| VS Code, Claude Desktop, JetBrains AI Assistant, Devin Desktop, Cline, Kiro | not stated | use way A or a global install |

For a fast start without a clone, install the package once:

```
npm install -g github:jonathan-moore58/portaldot-builder-kit
```

and use the command `portaldot-builder-kit` in place of `npx` and its arguments. In our test (from a local git copy) the install took 39 seconds once, and each start then took 1.3 to 1.4 seconds. Run the same install again to update.

We do not publish this package on the npm registry. Always write the `github:` form: without it, npx looks for a package of that name on the registry. When npm fetches the package it also contacts the npm registry itself (see [SECURITY.md](../SECURITY.md)).

### Windows

- **Way A:** `node` starts as it is. In JSON, write the path with forward slashes, `C:/dev/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`, or with doubled backslashes, `C:\\dev\\portaldot-builder-kit\\...`.
- **Way B:** `npx` is a batch file (`npx.cmd`). In our tests on Windows, a program that starts a command without a shell could not start it (`npx` gave ENOENT, `npx.cmd` gave EINVAL), and `cmd /c npx` worked. So, unless your assistant's section says otherwise, write `"command": "cmd"` and `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`. The same goes for the global install: `"command": "cmd"`, `"args": ["/c", "portaldot-builder-kit"]`.

### Check that it starts

Run the command of way A or B in a terminal. The server writes `[portaldot-dev] ready on stdio, 16 tools, ...` to stderr and waits for a client. Ctrl+C stops it. If your assistant later reports the server as failed, look for that line in the assistant's MCP log.

### Settings and proxies

The server needs no settings and no API key. Its optional environment variables (the network to use by default, other endpoints) are in the README's [Settings](../README.md#settings). They go in the server's entry: the field is `env` in most assistants, `environment` in opencode and `envs` in Goose. Several assistants do not pass your shell's variables to the server; the sections say so where the documentation does. Writing the values in the entry is the safe choice.

Behind a proxy, set `HTTPS_PROXY` (and `NO_PROXY` if you need it) and also `NODE_USE_ENV_PROXY=1`. The Claude Code plugin sets that last one for its server; in other assistants you set it yourself:

```json
"env": { "HTTPS_PROXY": "http://proxy.example:8080", "NODE_USE_ENV_PROXY": "1" }
```

The details, and what was tested, are in the README's [Cloud sessions and proxies](../README.md#cloud-sessions-and-proxies).

### What the kit gives your assistant

- **16 read-only tools.** Every assistant gets them. None signs or sends, and none needs a key.
- **Instructions for the model**, sent when the session starts: when to use the tools, and which habits from Polkadot, Substrate and Ethereum are wrong here.
- **The knowledge pack**: the tool `read_guide` gives any section of it, and each file is also a resource at `portaldot://guide/<name>` (for example `portaldot://guide/errors`).
- **A prompt**, `start_project` ("Start a Portaldot V3 project"), with one optional argument, `idea`, for starting a new project.

The tools work in every assistant. What happens to the other three parts depends on the assistant:

| Assistant | Server instructions reach the model | The prompt `start_project` | The model can read resources |
| --- | --- | --- | --- |
| VS Code with GitHub Copilot | not stated | not offered | no |
| Cursor | not stated | supported, place not stated | supported, reader not stated |
| Codex | yes | not stated | not stated |
| Claude Desktop | not stated | not stated | not stated |
| GitHub Copilot CLI | partly | not stated | not stated |
| Gemini CLI | yes | `/start_project` | yes |
| JetBrains AI Assistant | not stated | not stated | not stated |
| JetBrains Junie | not stated | not stated | not stated |
| Devin Desktop | not stated | `/mcp__portaldot__start_project` | yes |
| Cline | not stated | `/mcp:portaldot:start_project` | not stated |
| Zed | not stated | supported, place not stated | no |
| Kiro | not stated | in the `#` menu | not stated |
| opencode | yes | `/portaldot:start_project` | yes |
| Goose | not stated | not stated | not stated |
| Continue | not stated | not stated | not stated |

Where resources cannot be read, `read_guide` gives the same text. Where the instructions may not reach the model, the [standing instructions](#standing-instructions) close the gap.

## VS Code with GitHub Copilot

**Settings.** VS Code's current pages (dated Nov 11, 2026) name two files for its default Copilot harness: `~/.copilot/mcp-config.json` for all your workspaces (`$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set), and `.mcp.json` at the workspace root for one project. GitHub Copilot CLI reads the same files. You can also use **Chat: Open Customizations > MCP Servers > Add Server**, then **Global > Copilot Global** for the user file.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"],
      "tools": ["*"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"],
      "tools": ["*"]
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- Keep `"args"` and `"tools": ["*"]`. VS Code points to GitHub's Copilot CLI reference for the shared runtime, and that reference marks both as required.
- Two official sites disagree. docs.github.com still teaches `.vscode/mcp.json` with a `servers` key; VS Code's own pages say that file belongs to the deprecated Local harness, to be removed in February 2027, and that the Copilot harness does not read it directly. Use the files above. Only if your VS Code still runs the Local harness, put the entry in `.vscode/mcp.json` as `{"servers": {"portaldot": {"type": "stdio", "command": "node", "args": ["..."]}}}`.
- Variables go in an `"env"` object. A reference to another variable must be braced, `${NAME}`: a bare `$NAME` stays literal text.
- docs.github.com names VS Code 1.99 or later. On Copilot Business or Enterprise, the organization policy "MCP servers in Copilot" must be on, and it is off by default.
- The pages give only the `~` form of the user file, no Windows notes and no start-up limit. Use way A.

**What the kit's parts become**

- Server instructions: not stated on VS Code's pages. GitHub's Copilot CLI reference, for the same runtime, says only allowlisted servers' instructions go into the prompt at the start; the others are fetched when needed.
- `start_project`: not offered. VS Code says MCP prompts are not shown in Copilot sessions. (The deprecated Local harness showed it as `/mcp.portaldot.start_project`.)
- Resources: not read. Copilot sessions read resources only for MCP Apps. `read_guide` gives the same text.

Standing instructions: `AGENTS.md` or `.github/copilot-instructions.md` ([text](#standing-instructions)).

Official pages: https://code.visualstudio.com/docs/agents/reference/mcp-configuration and https://code.visualstudio.com/api/extension-guides/ai/mcp

## Cursor

**Settings.** `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in a project. Cursor merges the two; on a name clash the project entry wins. Save the file and restart Cursor. Cursor's `agent` command line reads the same files. The pages give only the `~` form of the path, for every system.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"],
      "startupTimeoutSec": 120
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- The field table marks `"type": "stdio"` as required, while the page's examples leave it out. Keep it.
- A stdio server gets 60 seconds to start; `startupTimeoutSec` raises that to at most 5 minutes (release notes).
- Variables: an `env` object, an `envFile`, and references such as `${env:NAME}`. A variable from your shell profile must be visible to Cursor; restart Cursor after changing it.
- Cursor asks for approval before it uses an MCP tool, by default.
- Windows: no notes on starting commands. One admin feature, MCP network controls, cannot sandbox a server on Windows; such a server does not start there until the admin gives it the "No sandbox" mode.

**What the kit's parts become**

- Server instructions: not stated.
- `start_project`: Cursor lists MCP prompts as supported, but does not say where they appear.
- Resources: listed as supported; whether the model or only you can read them is not stated. `read_guide` gives the same text.

Standing instructions: `AGENTS.md`, or a rule file `.cursor/rules/portaldot.mdc` that starts with the three lines `---`, `alwaysApply: true`, `---`. Cursor's rules page says such a rule is always included, while a rule with `alwaysApply: false` and no description or globs is included only when you @-mention it; a plain `.md` file in that folder is ignored ([text](#standing-instructions)).

Official pages: https://cursor.com/docs/mcp and https://cursor.com/help/customization/mcp

## OpenAI Codex

The Codex CLI, its IDE extension and the ChatGPT desktop app share one configuration.

**Settings.** `~/.codex/config.toml` (on Windows `%USERPROFILE%\.codex\config.toml`; `CODEX_HOME` moves the folder). A project's `.codex/config.toml` loads only in a project you trust. Or run `codex mcp add portaldot -- node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`; the page does not say which file it writes.

Way A:

```toml
mcp_optional_startup_grace_ms = 0

[mcp_servers.portaldot]
command = "node"
args = ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
```

Way B:

```toml
mcp_optional_startup_grace_ms = 0

[mcp_servers.portaldot]
command = "npx"
args = ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
startup_timeout_sec = 120
```

On Windows, way B: `command = "cmd"` and `args = ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`. Write Windows paths with forward slashes, or in 'single quotes': inside "double quotes" a backslash starts an escape (a TOML rule; Codex's pages do not mention it).

**What the documentation says that matters here**

- Codex gives a server 10 seconds to start (`startup_timeout_sec`). When it builds its first list of tools, it waits at most 1 second in all for servers not marked `required` (`mcp_optional_startup_grace_ms`, default 1000; 0 makes it wait for each server's own timeout). The pages do not say whether a server that misses that second is added later. Way A answered in 0.3 to 1.5 seconds in our tests, at times more than that second, so the snippets set the grace to 0. It is a top-level setting: keep it above the first `[table]` line, or TOML reads it as part of that table.
- Variables: values in a `[mcp_servers.portaldot.env]` table, or `env_vars = ["HTTPS_PROXY"]` to pass on your own variable. The pages do not say which variables the server gets without them.
- With `default_tools_approval_mode = "writes"` in the server's table, Codex asks only before tools that are not marked read-only. All 16 tools are marked read-only.
- Codex run inside WSL uses the Linux home folder, not `%USERPROFILE%\.codex`.

**What the kit's parts become**

- Server instructions: yes. Codex uses them "as server-wide guidance alongside the server's tools", and asks servers to keep the first 512 characters self-contained.
- `start_project`: not stated.
- Resources: not stated in the user documentation. `read_guide` gives the same text.

Standing instructions: `AGENTS.md` ([text](#standing-instructions)).

Official pages: https://learn.chatgpt.com/docs/extend/mcp?surface=cli and https://learn.chatgpt.com/docs/config-file/config-reference

## Claude Desktop

**Settings.** One file per user, `claude_desktop_config.json`: on macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows `%APPDATA%\Claude\claude_desktop_config.json`. Open it from **Settings > Developer > Edit Config**. After saving, quit Claude Desktop completely and start it again. There is no project-level file.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

On Windows, write the absolute path with doubled backslashes, as the official Windows example does: `"args": ["C:\\dev\\portaldot-builder-kit\\plugins\\portaldot-dev\\server\\index.mjs"]`.

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

On Windows, the official example starts `npx` directly, as above. If the server does not start, use `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- This file needs your own Node.js. (The Node.js built into Claude Desktop is for desktop extensions, which this kit does not ship.)
- Windows and npx: if the server's log mentions `${APPDATA}`, the guide says to add the expanded value of `%APPDATA%` to `env`; and npx may keep failing until npm is installed globally (then the folder `%APPDATA%\npm` exists). Way A avoids both.
- Logs on Windows are in `%APPDATA%\Claude\logs`; `mcp-server-portaldot.log` holds the server's stderr.
- Variables: an `env` object. No `${VAR}` references are stated for this file, so write the values.
- No start-up limit is stated. An administrator can turn off the servers that users add.
- The pages disagree about Linux: the MCP project's guide gives a Linux path (`~/.config/Claude/claude_desktop_config.json`), while the pages on claude.com name only macOS and Windows.
- Claude Desktop can also add plugins from a GitHub marketplace (Customize > Plugins). Their local servers load in Cowork and in the Code tab, but not in plain chat. We have not tried this kit's plugin that way.

**What the kit's parts become**

- Server instructions, `start_project` and resources: the documentation does not say how Claude Desktop uses them. `read_guide` gives the knowledge in any case.

Standing instructions: no file. Type the text into the app's standing instructions, for example the Instructions of a Cowork project ([text](#standing-instructions)).

Official pages: https://modelcontextprotocol.io/docs/develop/connect-local-servers and https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

## GitHub Copilot CLI

**Settings.** The user file `~/.copilot/mcp-config.json` (`COPILOT_HOME` moves the folder), which VS Code reads too. For one project: `.mcp.json` in any folder from the working folder up to the repository root, or `.github/mcp.json`, which is meant to be committed; project entries win over the user file. `.vscode/mcp.json` is not read. Or run `copilot mcp add portaldot -- node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`, which writes the user file, or `/mcp add` inside a session.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"],
      "tools": ["*"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"],
      "tools": ["*"],
      "timeout": 120000
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- Only `PATH` comes from your environment; every other variable must be in `env`, where `$VAR`, `${VAR}` and `${VAR:-default}` work. Behind a proxy: `"env": {"HTTPS_PROXY": "${HTTPS_PROXY}", "NODE_USE_ENV_PROXY": "1"}`.
- Project files load only after you confirm folder trust; in an untrusted folder they are skipped without a message. The user file is not affected.
- `type` may be `"local"` (the default) or `"stdio"`. The reference marks `tools` as required, while one example leaves it out: keep `["*"]`.
- `timeout` (milliseconds) covers finding the tools and each call: 30000 by default, and at least 60000 for the connection.
- `deferTools` is `"auto"` by default, so tool search may keep the tools out of the list; `"deferTools": "never"` keeps them listed.
- The tools appear as `portaldot-<tool>`, at most 64 characters; all 16 fit.
- It needs an active Copilot subscription. Two GitHub pages disagree on whether the organization policy "MCP servers in Copilot" applies to the CLI.
- Windows: supported in PowerShell 6 or later and in WSL; no notes on starting commands.

**What the kit's parts become**

- Server instructions: partly. Only allowlisted servers' instructions go into the prompt at the start; the others are fetched when needed. Which servers are allowlisted is not stated. `--allow-all-mcp-server-instructions` puts all of them in at the start.
- `start_project` and resources: not stated for the CLI. `read_guide` gives the same text.

Standing instructions: `AGENTS.md`. The CLI also merges `.github/copilot-instructions.md`, `CLAUDE.md` and `GEMINI.md`, so put the text in one of them only ([text](#standing-instructions)).

Official pages: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference

## Gemini CLI

**Settings.** `~/.gemini/settings.json` for all projects (`GEMINI_CLI_HOME` moves it), `.gemini/settings.json` for one project. For way A you can also run `gemini mcp add -s user portaldot node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`; without `-s user` it writes the project file.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- In a folder you have not trusted, Gemini CLI connects no MCP servers at all and ignores the project's settings. Run `gemini trust` in the project, or accept the trust prompt. Two of its pages disagree on whether folder trust is on by default; trust the folder either way.
- Variables: an `env` object, with `$VAR` or `${VAR}`, and `%VAR%` on Windows. Variables from your environment whose names contain TOKEN, SECRET, PASSWORD, KEY, AUTH or CREDENTIAL are removed unless they are listed in `env`.
- Each request may take 600 seconds by default (`timeout`, in milliseconds), so way B fits.
- The tools appear as `mcp_portaldot_<tool>`.
- Gemini CLI itself needs Node.js 20 or later.

**What the kit's parts become**

- Server instructions: yes, "appended to the system instructions".
- `start_project`: a slash command, `/start_project`, with named arguments: `/start_project --idea="an NFT ticket shop"`.
- Resources: yes. The model reads them with its built-in `read_mcp_resource` tool, and you can attach one with `@portaldot://guide/errors`.

Standing instructions: `GEMINI.md`. To use `AGENTS.md`, add `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` to the settings ([text](#standing-instructions)).

Official page: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md

## JetBrains AI Assistant

**Settings.** No file is named. Go to **Settings | Tools | AI Assistant | Model Context Protocol (MCP)**, click **Add** and paste the JSON. The Level column makes the server global or for the current project only. **Import from Claude** copies the servers of Claude Desktop's settings.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- None of the page's examples has an `env` field, and the page does not say how to pass variables to a server.
- No Windows notes and no start-up limit are stated. Use way A.
- AI Assistant needs IDE version 2023.3 or later. The page does not say whether MCP needs a paid AI plan. An administrator can set the servers for you and stop you adding your own.
- You can also call a tool yourself with `/` in the chat.

**What the kit's parts become**

- Server instructions, `start_project` and resources: not stated. `read_guide` gives the knowledge in any case.

Standing instructions: a rule file in `.aiassistant/rules/` (Settings | Tools | AI Assistant | Rules), with the rule type Always. Most agents in AI Chat read `AGENTS.md` (Claude Agent reads `CLAUDE.md`) ([text](#standing-instructions)).

Official page: https://www.jetbrains.com/help/ai-assistant/mcp.html

## JetBrains Junie

**Settings.** `.junie/mcp/mcp.json` in the project (it can be committed), or `~/.junie/mcp/mcp.json` for all projects; servers added in **Settings | Tools | Junie | MCP Settings** are saved to the user file. Junie CLI reads the same files. Junie inside AI Chat does not: it uses AI Assistant's list, and only when **Tools | AI Assistant | Agents > Pass custom MCP servers** is on.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"],
      "timeout": 120000
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- Junie waits 60 seconds for each request to a server, the start-up handshake included. `timeout` (milliseconds, 1000 to 3600000) raises it.
- Variables: an `env` object.
- Junie takes at most 100 tools from all servers together; the kit has 16.
- MCP tool calls need your approval unless you allow them.
- The Windows path of the user file is not stated.

**What the kit's parts become**

- Server instructions, `start_project` and resources: not stated. `read_guide` gives the knowledge in any case.

Standing instructions: `.junie/AGENTS.md` if it exists (Junie then reads only that file), otherwise `AGENTS.md` at the project root ([text](#standing-instructions)).

Official pages: https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html and https://junie.jetbrains.com/docs/junie-ide-plugin.html

## Devin Desktop

Windsurf became Devin Desktop on June 2, 2026. Its agent, Devin Local, shares its settings with Devin CLI.

**Settings.** `~/.config/devin/mcp_config.json` for all projects (on Windows `%APPDATA%\devin\mcp_config.json`); in a project, `.devin/mcp_config.json` (committed) or `.devin/mcp_config.local.json` (ignored by git). To open them: the **Customize** page, then **MCPs**. Or run `devin mcp add -s user portaldot -- node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`; without `-s user` it writes the local project file.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- These files exist since Devin CLI v3000.3 (Devin Local 3.6). Older builds kept the servers in `config.json` and move them on start.
- Official pages disagree on the old Windsurf paths (under `~/.codeium/`). Use the files above.
- By default Devin also reads the servers of `.mcp.json`, `.cursor/mcp.json` and Claude Code's settings files, so an entry you made for another assistant can appear here too.
- Variables: an `env` object, or `-e KEY=VALUE` on `devin mcp add`. Whether `${env:NAME}` works in a local server's `env` is not stated, so write the values.
- Plan mode allows only tools marked `readOnlyHint: true`; all 16 tools are.
- The agent asks for approval before every MCP tool call by default. Devin Local may need switching on in Devin Settings, and agents are not available in Restricted Mode.
- No notes on Windows and npx, and no start-up limit, are stated. Use way A.

**What the kit's parts become**

- Server instructions: not stated.
- `start_project`: a slash command, `/mcp__portaldot__start_project`; the text after it fills the arguments in order.
- Resources: the agent can list and read them (changelog). The tools appear as `mcp__portaldot__<tool>`.

Standing instructions: `AGENTS.md` (Devin also reads `AGENT.md`, `CLAUDE.md` and rules in `.devin/rules/`) ([text](#standing-instructions)).

Official pages: https://docs.devin.ai/desktop/devin-local/customizations and https://docs.devin.ai/cli/extensibility/mcp/configuration

## Cline

**Settings.** One global file, `~/.cline/data/settings/cline_mcp_settings.json`, shared by the extension and the Cline CLI (`CLINE_MCP_SETTINGS_PATH` moves it). In the extension, open it from the Cline panel: the **MCP Servers** icon, the **Configure** tab, then **Configure MCP Servers**. No project-level file is documented. Or run `cline mcp add portaldot --yes -- node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- Keep `"type": "stdio"`: the page says an entry without `type` uses the legacy `sse` transport.
- Variables: an `env` object. No `--env` option is documented for `cline mcp add`; edit the JSON instead.
- The MCP settings let you set request timeouts, but no default is stated, and there are no Windows notes. Use way A.

**What the kit's parts become**

- Server instructions: not stated.
- `start_project`: Cline's changelog (3.55.0) says MCP prompts appear in the slash commands as `/mcp:<server>:<prompt>`, so `/mcp:portaldot:start_project`.
- Resources: not stated. `read_guide` gives the same text.

Standing instructions: `AGENTS.md`, or a file in `.clinerules/` ([text](#standing-instructions)).

Official page: https://docs.cline.bot/mcp/mcp-overview

## Zed

**Settings.** The `context_servers` key of Zed's settings: `~/.config/zed/settings.json` on macOS and Linux, `%APPDATA%\Zed\settings.json` on Windows, or `.zed/settings.json` in a project. **Settings > AI > MCP Servers > Add Server > Add Local Server** writes the entry for you. If the file has other settings, add the `context_servers` key to its top-level object.

Way A:

```json
{
  "context_servers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"],
      "env": {}
    }
  }
}
```

Way B:

```json
{
  "context_servers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"],
      "env": {},
      "timeout": 120
    }
  }
}
```

On Windows, way B: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- A server gets 60 seconds by default (`context_server_timeout`); a server's own `timeout` overrides it, up to 600 seconds.
- A server in `.zed/settings.json` starts only in a trusted worktree (Restricted Mode blocks it). Servers in your user settings start either way.
- Zed asks before each tool call by default.
- No Windows notes on starting commands.

**What the kit's parts become**

- Server instructions: not stated.
- `start_project`: Zed supports MCP prompts, but its pages do not say where they appear.
- Resources: not supported (Zed supports tools and prompts). `read_guide` gives the same text.

Standing instructions: `AGENTS.md`. Zed reads only the first of these files that the project has: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. If the project has one that comes before `AGENTS.md`, put the text there ([text](#standing-instructions)).

Official page: https://zed.dev/docs/ai/mcp

## Kiro and Kiro CLI

Kiro CLI is the new form of Amazon Q Developer CLI. It still reads a project's `.amazonq/mcp.json` (a `.kiro` folder wins), copies `~/.aws/amazonq/mcp.json` to `~/.kiro/settings/mcp.json`, and keeps the `q` and `q chat` commands.

**Settings.** `.kiro/settings/mcp.json` in the workspace, or `~/.kiro/settings/mcp.json` for all workspaces. Kiro merges the two; the workspace entry wins. In the IDE, first turn on the MCP support setting (Settings, search "MCP"), then use **Kiro: Open user MCP config (JSON)** from the Command Palette. Kiro Web reads the repository's `.kiro/settings/mcp.json`. A change applies when you save the file.

Way A:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

Way B:

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "npx",
      "args": ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    }
  }
}
```

**What the documentation says that matters here**

- Windows: in Kiro CLI V2 sessions, a command that resolves on `PATH` to a `.exe`, `.com`, `.bat` or `.cmd` file starts directly, so `npx` needs no `cmd /c` there. For the IDE this is not stated: use way A, or `"command": "cmd"`, `"args": ["/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`. Kiro CLI on Windows needs Windows 11 with PowerShell or Windows Terminal.
- Variables: an `env` object. In the IDE a `${NAME}` reference expands only for variables you approve (the setting "Mcp Approved Env Vars"); Kiro CLI takes them from your shell and does not load a `.env` file.
- A tool is dropped when its name, with the server prefix, is longer than 64 characters or does not match `^[a-zA-Z][a-zA-Z0-9_]*$`. All 16 tools fit.
- `kiro-cli mcp add`: two of its pages disagree on whether it takes `--args`. Edit the JSON instead.
- No start-up limit is stated. Use way A.

**What the kit's parts become**

- Server instructions: not stated.
- `start_project`: in the `#` menu of the chat; you pick it, Kiro never sends a prompt on its own.
- Resources: Kiro documents resource templates in the `#` menu. The kit's resources are plain files, and what Kiro does with those is not stated. `read_guide` gives the same text.

Standing instructions: `AGENTS.md` (always included), or a file in `.kiro/steering/` ([text](#standing-instructions)).

Official pages: https://kiro.dev/docs/mcp/configuration/ and https://kiro.dev/docs/mcp/usage/

## opencode

**Settings.** `~/.config/opencode/opencode.json` (or `.jsonc`) for all projects; `opencode.json` or `.opencode/opencode.json` in a project. Or run `opencode mcp add portaldot --global -- node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`; without `--global` it writes the project's settings. The snippets are in the shape of opencode V2, the current version; on V1, put `"portaldot"` directly under `"mcp"`, a shape V2 still reads, and leave out the `timeout` object, which is V2's.

Way A:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "portaldot": {
        "type": "local",
        "command": ["node", "/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
      }
    }
  }
}
```

Way B:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "portaldot": {
        "type": "local",
        "command": ["npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"],
        "timeout": { "startup": 120000 }
      }
    }
  }
}
```

On Windows, way B: `"command": ["cmd", "/c", "npx", "-y", "github:jonathan-moore58/portaldot-builder-kit"]`.

**What the documentation says that matters here**

- `command` is one list, the program first; there is no `args` key. `"type": "local"` is required.
- Variables: `environment` (not `env`), added to the environment opencode inherited. Reference a variable as `{env:NAME}`; `$NAME` is not expanded.
- Timeouts are in milliseconds: 30 seconds to start and 30 seconds to list the tools by default.
- By default (Code Mode) the model calls the tools as `tools.portaldot.<tool>(...)`.
- No Windows notes.

**What the kit's parts become**

- Server instructions: yes, added to the system prompt (left out when permissions deny every tool of the server).
- `start_project`: a command, `/portaldot:start_project`.
- Resources: yes. The model reads them with the built-in tools `list_mcp_resources` and `read_mcp_resource`.

Standing instructions: `AGENTS.md` (opencode V2 does not read `CLAUDE.md`) ([text](#standing-instructions)).

Official page: https://opencode.ai/docs/mcp-servers

## Goose

**Settings.** One user file: `~/.config/goose/config.yaml` on macOS and Linux, `%APPDATA%\Block\goose\config\config.yaml` on Windows. `goose configure`, then **Add Extension > Command-line Extension**, asks for the same values; the desktop app has an Extensions page. To try the server in one session only: `goose session --with-extension "node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"`.

Way A:

```yaml
extensions:
  portaldot:
    type: stdio
    name: portaldot
    enabled: true
    cmd: node
    args: ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    envs: {}
    env_keys: []
    timeout: 300
```

Way B:

```yaml
extensions:
  portaldot:
    type: stdio
    name: portaldot
    enabled: true
    cmd: npx
    args: ["-y", "github:jonathan-moore58/portaldot-builder-kit"]
    envs: {}
    env_keys: []
    timeout: 300
```

**What the documentation says that matters here**

- The keys are `cmd` (not `command`), `args` and `envs` (not `env`); `type: stdio` is needed. `timeout` is in seconds.
- Windows: Goose expects Node.js in `C:\Program Files\nodejs\`. If yours is elsewhere, the documented fix is `mklink /D "C:\Program Files\nodejs" "<your Node.js folder>"`. Goose brings its own npx; its pages give no `cmd /c` advice, so on Windows way A is the safer choice.
- Goose checks packages that it starts with npx against a malware database.
- Variables: the `envs` map, or names in `env_keys` that Goose looks up in your environment or its secret store.

**What the kit's parts become**

- Server instructions, `start_project` and resources: not stated in the documentation. `read_guide` gives the knowledge in any case.

Standing instructions: `AGENTS.md` or `.goosehints` ([text](#standing-instructions)).

Official pages: https://goose-docs.ai/docs/guides/config-files and https://goose-docs.ai/docs/getting-started/using-extensions

## Continue

Continue made a final 2.0.0 release, and its repository is no longer maintained. Its documentation is still online.

**Settings.** `~/.continue/config.yaml` for all projects (on Windows `%USERPROFILE%\.continue\config.yaml`), under `mcpServers:`, which is a list. For one project, a file in `.continue/mcpServers/`; a JSON file in the `mcpServers` shape of the other assistants is read there too (for example `.continue/mcpServers/mcp.json`). Continue reloads when you save.

Way A, as `.continue/mcpServers/portaldot.yaml`:

```yaml
name: portaldot
version: 0.0.1
schema: v1
mcpServers:
  - name: portaldot
    type: stdio
    command: node
    args:
      - "/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"
```

Way B:

```yaml
name: portaldot
version: 0.0.1
schema: v1
mcpServers:
  - name: portaldot
    type: stdio
    command: npx
    args:
      - "-y"
      - "github:jonathan-moore58/portaldot-builder-kit"
```

On Windows, way B: `command: cmd` and the arguments `"/c"`, `"npx"`, `"-y"`, `"github:jonathan-moore58/portaldot-builder-kit"`.

**What the documentation says that matters here**

- A file in `.continue/mcpServers/` needs `name`, `version` and `schema` at the top, as above. In `config.yaml` they are already there; add only the list entry.
- MCP works only in agent mode.
- The IDE extensions cannot read your shell's variables. Write values in `env`, or as `${{ secrets.NAME }}` with the value in a `.env` file (`.env` or `.continue/.env` in the workspace, or `~/.continue/.env`).
- `connectionTimeout` sets the wait for the first connection; its default is not given. Use way A.
- No Windows notes.

**What the kit's parts become**

- Server instructions, `start_project` and resources: not stated in the documentation. `read_guide` gives the knowledge in any case.

Standing instructions: a Markdown file in `.continue/rules/` ([text](#standing-instructions)).

Official page: https://docs.continue.dev/customize/deep-dives/mcp

## Any other MCP client

The general shape is a command, its arguments and an environment:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"],
  "env": {}
}
```

What a client's author may want to know:

| Question | Answer |
| --- | --- |
| Transport | stdio: one JSON-RPC message per line. Nothing but protocol messages goes to stdout. |
| Command | `node <clone>/plugins/portaldot-dev/server/index.mjs` with no arguments; or `npx -y github:jonathan-moore58/portaldot-builder-kit`; or `portaldot-builder-kit` after `npm install -g github:jonathan-moore58/portaldot-builder-kit`. On Windows, start the last two through `cmd /c`. |
| Runtime | Node.js 20 or later. The built file has no dependencies to install. |
| Protocol versions | Our test client negotiated 2025-11-25 and 2026-07-28, and every check passed in both. |
| Server | name `portaldot-dev`, title "Portaldot V3 chain tools, by the Bridge Zero team", and the version of the release. |
| Capabilities | `tools`; `resources`, with a list that does not change and no subscriptions; `prompts` only when the build has one. |
| Instructions | Sent in the answer to `initialize`, under 4,096 characters. |
| Tools | 16. Every one is annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`; `openWorldHint` is `true` for the 14 that read the chain and `false` for `convert_amount` and `read_guide`. Names match `^[a-z][a-z0-9_]*$` and have at most 24 characters. Answers are text; a longer answer is cut at 19,000 characters and ends with a note that says so. |
| Resources | `portaldot://guide/<name>`, one per knowledge file, `text/markdown`. |
| Prompts | `start_project`, title "Start a Portaldot V3 project", one optional argument `idea`. |
| Authentication | None: no API key, no login, no account. |
| Environment | None needed. Optional: `PORTALDOT_DEFAULT_NETWORK`, `PORTALDOT_TESTNET_WS`, `PORTALDOT_MAINNET_WS`, `PORTALDOT_TESTNET_EVM`, `PORTALDOT_MAINNET_EVM`, and behind a proxy `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` with `NODE_USE_ENV_PROXY=1`. See the README's [Settings](../README.md#settings). |
| Network | Only the public Portaldot endpoints, or the ones set above, and only when a tool needs the chain. A connection idle for five minutes is closed. Nothing is sent to us. |
| Working folder | Any. `simulate_contract_deploy` reads a build artifact only from inside the project folder; outside Claude Code, that is the folder the server was started in. |
| stderr | A line when it is ready (`[portaldot-dev] ready on stdio, 16 tools, the knowledge files as resources, ...`), a line when it stops, and messages from the libraries it uses, for example when a connection to a node drops. Values it knows to be secret, such as a key inside an endpoint you set, are written as `[hidden]`. |
| Stopping | When stdin closes, or on SIGINT or SIGTERM. It exits within about a second. |
| Files | It writes none. |

## Standing instructions

Several assistants do not say whether they pass the server's instructions to the model. Paste this block into your project's instructions file, so that the model knows when to use the tools. It takes its habits from rules 1, 2, 3, 4, 5, 6 and 11 of the knowledge pack: `read_guide {"topic": "portaldot-v3/rules-prevent-costly-mistakes"}`, or [SKILL.md](../plugins/portaldot-dev/skills/portaldot-v3/SKILL.md) in this repository.

```markdown
## Portaldot V3

This project builds on Portaldot V3 (tokens tPOT and POT, the Revive module, endpoints on portaldot.dev). Habits from Polkadot, Substrate and Ethereum are wrong there in several places, so use the tools of the `portaldot` MCP server instead of answering from memory.
- Start with `get_chain_facts`. Never guess a call's name, arguments or index: use `search_chain`, then `describe_item`; `encode_call` gives the exact bytes.
- For how to do something or why the chain behaves as it does, call `read_guide` (for example `{"query": "storage deposit deploy"}`); for any error text, call `explain_error`. Contract events of native calls are not in `eth_getLogs`: use `get_contract_events`.
- Addresses: every account has a `5...` form and a `0x` form, linked by a rule, not by a shared key. Run `convert_address` before paying across the two sides.
- Amounts: native amounts have 14 decimals; the Ethereum side shows 18 (1 base unit = 10^4 wei). Use `convert_amount`, and BigInt for every amount.
- Ethereum transactions: gas includes the storage deposit, so estimates look huge. Take the gas limit from `eth_estimateGas` (up to 10 percent more, never less), never from habit or from `forge script`, and run `estimate_eth_transaction` before sending.
- Before each send, check whether a transaction of the account still waits for its block: `get_account` (it reads `system_accountNextIndex`). The Ethereum RPC cannot see a waiting transaction: `eth_getTransactionByHash` answers `null` and the "pending" count equals "latest" (measured on Nov 15, 2026). Never resend because of that; sign with an explicit nonce.
- Never put a real private key or recovery phrase in code, config, logs or a prompt. The tools never need one, and none signs or sends. Use a fresh test key, and the testnet first.
- The tools say when a fact was measured and when it was only reported by others; pass that on.
```

Where to put it:

| Assistant | File |
| --- | --- |
| VS Code with GitHub Copilot | `AGENTS.md` or `.github/copilot-instructions.md` |
| Cursor | `AGENTS.md`, or a rule `.cursor/rules/portaldot.mdc` with `alwaysApply: true` |
| Codex | `AGENTS.md` |
| Claude Desktop | no file: the app's standing instructions, for example a Cowork project's Instructions |
| GitHub Copilot CLI | `AGENTS.md` (it also merges `.github/copilot-instructions.md`, `CLAUDE.md` and `GEMINI.md`: use one) |
| Gemini CLI | `GEMINI.md`, or `AGENTS.md` once it is in `context.fileName` |
| JetBrains AI Assistant | a rule in `.aiassistant/rules/` of type Always; most of its agents read `AGENTS.md` |
| JetBrains Junie | `.junie/AGENTS.md` if it exists, otherwise `AGENTS.md` |
| Devin Desktop | `AGENTS.md` |
| Cline | `AGENTS.md` or a file in `.clinerules/` |
| Zed | `AGENTS.md`, unless the project has a file Zed reads first (see [Zed](#zed)) |
| Kiro | `AGENTS.md` or a file in `.kiro/steering/` |
| opencode | `AGENTS.md` |
| Goose | `AGENTS.md` or `.goosehints` |
| Continue | a file in `.continue/rules/` |
