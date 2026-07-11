# Coolify MCP Server

[![npm version](https://img.shields.io/npm/v/@masonator/coolify-mcp.svg)](https://www.npmjs.com/package/@masonator/coolify-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@masonator/coolify-mcp.svg)](https://www.npmjs.com/package/@masonator/coolify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@masonator/coolify-mcp.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/StuMason/coolify-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/StuMason/coolify-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/StuMason/coolify-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/StuMason/coolify-mcp)

> **The most comprehensive MCP server for Coolify** - now hardened by the Orca internal fork to expose exactly 15 tools for managing your self-hosted PaaS through AI assistants. (Orca internal fork: the obot gateway hosting this server has no per-server tool filter, so the fork itself is the enforcement layer — all destructive, batch-operation, and non-essential tools are removed at the registration level. See the fork's README note below.)

📖 **Docs**: [**coolify-mcp.stumason.dev**](https://coolify-mcp.stumason.dev) — install guide, quickstart, full tools reference, MCP primer, Coolify API gotchas, contributing guide, and the public v3 roadmap.

> 💡 **Building a Laravel app?** Check out [**laravel-coolify**](https://github.com/StuMason/laravel-coolify) — deploy Laravel to Coolify with a Horizon-style dashboard, Artisan commands, and auto-generated Dockerfiles.

A Model Context Protocol (MCP) server for [Coolify](https://coolify.io/), enabling AI assistants to manage and debug your Coolify instances through natural language.

## Features

This MCP server provides **15 token-optimized tools** for **debugging, management, and deployment** (Orca internal fork — hardened to expose only these 15 tools; the obot gateway has no per-server tool filter, so this is the enforcement layer):

| Category           | Tools                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Infrastructure** | `get_infrastructure_overview`, `get_version`                                                                                 |
| **Diagnostics**    | `diagnose_app`, `find_issues`                                                                                                |
| **Servers**        | `list_servers`                                                                                                               |
| **Projects**       | `projects` (list, get, create, update via action param — delete removed in this fork)                                        |
| **Environments**   | `environments` (list, get, create via action param — delete removed in this fork)                                            |
| **Applications**   | `list_applications`, `application` (create/update only — delete and delete_preview removed in this fork), `application_logs` |
| **Control**        | `control` (start/stop/restart for apps, databases, services)                                                                 |
| **Env Vars**       | `env_vars` (CRUD + bulk_update for application, service, and database env vars)                                              |
| **Deployments**    | `list_deployments`, `deploy`, `deployment` (get, cancel, list_for_app)                                                       |

### Token-Optimized Design

The server uses **85% fewer tokens** than a naive implementation (6,600 vs 43,000) by consolidating related operations into single tools with action parameters. This prevents context window exhaustion in AI assistants.

## Installation

### Prerequisites

- Node.js >= 18
- A running Coolify instance (tested with v4.0.0-beta.460)
- Coolify API access token (generate in Coolify Settings > API)

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": ["-y", "@masonator/coolify-mcp"],
      "env": {
        "COOLIFY_ACCESS_TOKEN": "your-api-token",
        "COOLIFY_BASE_URL": "https://your-coolify-instance.com"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add coolify \
  -e COOLIFY_BASE_URL="https://your-coolify-instance.com" \
  -e COOLIFY_ACCESS_TOKEN="your-api-token" \
  -- npx @masonator/coolify-mcp@latest
```

> **Note:** Use `@latest` tag (not `-y` flag) for reliable startup in Claude Code CLI.

### Cursor

```bash
env COOLIFY_ACCESS_TOKEN=your-api-token COOLIFY_BASE_URL=https://your-coolify-instance.com npx -y @masonator/coolify-mcp
```

### Custom HTTP Headers (Cloudflare Zero Trust, Auth Proxies)

If your Coolify instance sits behind a Cloudflare Access tunnel or other auth-proxy middleware, pass extra headers on every outbound request with `--header`:

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "@masonator/coolify-mcp",
        "--header",
        "CF-Access-Client-Id: abc123.access",
        "--header",
        "CF-Access-Client-Secret: your-secret"
      ],
      "env": {
        "COOLIFY_ACCESS_TOKEN": "your-api-token",
        "COOLIFY_BASE_URL": "https://your-coolify-instance.com"
      }
    }
  }
}
```

Multiple `--header` flags can be combined. The reserved headers `Authorization` and `Content-Type` are filtered (with a warning) to prevent silently overriding the Coolify bearer token.

### Multiple Coolify servers

Each running instance of this MCP server is bound to one Coolify (one `COOLIFY_BASE_URL` + token). To work with several Coolify instances, pick whichever of these fits your workflow:

**Per-workspace config (recommended).** Most MCP clients support project-scoped config files (`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` in the repo root) alongside the global one. Put the Coolify credentials for _that project's_ estate in the project's own config, and "deploy this" automatically routes to the right Coolify whenever you're working in that repo — no server names to remember in conversation.

**Named instances in global config.** Register the server twice (or more) under distinct names, and address them by name in conversation ("deploy this on staging"):

```json
{
  "mcpServers": {
    "coolify-prod": {
      "command": "npx",
      "args": ["-y", "@masonator/coolify-mcp"],
      "env": {
        "COOLIFY_BASE_URL": "https://prod.coolify.example",
        "COOLIFY_ACCESS_TOKEN": "..."
      }
    },
    "coolify-staging": {
      "command": "npx",
      "args": ["-y", "@masonator/coolify-mcp"],
      "env": {
        "COOLIFY_BASE_URL": "https://staging.coolify.example",
        "COOLIFY_ACCESS_TOKEN": "..."
      }
    }
  }
}
```

The MCP server itself can't offer a settings screen or auto-detect the current repo — MCP servers are headless child processes and clients don't pass repo context — so routing lives in your client config, where both patterns above work today (see #164).

## Context-Optimized Responses

### Why This Matters

The Coolify API returns extremely verbose responses - a single application can contain 91 fields including embedded 3KB server objects and 47KB docker-compose files. When listing 20+ applications, responses can exceed 200KB, which quickly exhausts the context window of AI assistants like Claude Desktop.

**This MCP server solves this by returning optimized summaries by default.**

### How It Works

| Tool Type                     | Returns                                  | Use Case                            |
| ----------------------------- | ---------------------------------------- | ----------------------------------- |
| `list_*`                      | Summaries only (uuid, name, status, etc) | Discovery, finding resources        |
| `get_*`                       | Full details for a single resource       | Deep inspection, debugging          |
| `get_infrastructure_overview` | All resources summarized in one call     | Start here to understand your setup |

### Response Size Comparison

| Endpoint                | Full Response | Summary Response | Reduction |
| ----------------------- | ------------- | ---------------- | --------- |
| list_applications       | ~170KB        | ~4.4KB           | **97%**   |
| list_services           | ~367KB        | ~1.2KB           | **99%**   |
| list_servers            | ~4KB          | ~0.4KB           | **90%**   |
| list_application_envs   | ~3KB/var      | ~0.1KB/var       | **97%**   |
| deployment get          | ~13KB         | ~1KB             | **92%**   |
| deployment list_for_app | ~1MB          | ~4KB             | **99.6%** |

### HATEOAS-style Response Actions

Responses include contextual `_actions` suggesting relevant next steps:

```json
{
  "data": { "uuid": "abc123", "status": "running" },
  "_actions": [
    { "tool": "application_logs", "args": { "uuid": "abc123" }, "hint": "View logs" },
    {
      "tool": "control",
      "args": { "resource": "application", "action": "restart", "uuid": "abc123" },
      "hint": "Restart"
    }
  ],
  "_pagination": { "next": { "tool": "list_applications", "args": { "page": 2 } } }
}
```

This helps AI assistants understand logical next steps without consuming extra tokens.

### Recommended Workflow

1. **Start with overview**: `get_infrastructure_overview` - see everything at once
2. **Find your target**: `list_applications` - get UUIDs of what you need
3. **Dive deep**: `get_application(uuid)` - full details for one resource
4. **Take action**: `control(resource: 'application', action: 'restart')`, `application_logs(uuid)`, etc.

### Pagination

All list endpoints still support optional pagination for very large deployments:

```bash
# Get page 2 with 10 items per page
list_applications(page=2, per_page=10)
```

## Example Prompts

### Getting Started

```text
Give me an overview of my infrastructure
Show me all my applications
What's running on my servers?
```

### Debugging & Monitoring

```text
Diagnose my stuartmason.co.uk app
What's wrong with my-api application?
Find any issues in my infrastructure
Get the logs for application {uuid}
What environment variables are set for application {uuid}?
Show me recent deployments for application {uuid}
```

### Application Management

```text
Restart application {uuid}
Stop the database {uuid}
Start service {uuid}
Deploy application {uuid} with force rebuild
Update the DATABASE_URL env var for application {uuid}
```

### Project Setup

```text
Create a new project called "my-app"
Create a staging environment in project {uuid}
Deploy my app from private GitHub repo org/repo on branch main
Deploy nginx:latest from Docker Hub
Deploy from public repo https://github.com/org/repo
```

## Environment Variables

| Variable               | Required | Default                 | Description               |
| ---------------------- | -------- | ----------------------- | ------------------------- |
| `COOLIFY_ACCESS_TOKEN` | Yes      | -                       | Your Coolify API token    |
| `COOLIFY_BASE_URL`     | No       | `http://localhost:3000` | Your Coolify instance URL |

## Development

```bash
# Clone and install
git clone https://github.com/stumason/coolify-mcp.git
cd coolify-mcp
npm install

# Build
npm run build

# Test
npm test

# Run locally
COOLIFY_BASE_URL="https://your-coolify.com" \
COOLIFY_ACCESS_TOKEN="your-token" \
node dist/index.js
```

## Available Tools

### Infrastructure

- `get_version` - Get Coolify API version
- `get_infrastructure_overview` - Get a high-level overview of all infrastructure (servers, projects, applications, databases, services)

### Diagnostics (Smart Lookup)

These tools accept human-friendly identifiers instead of just UUIDs:

- `diagnose_app` - Get comprehensive app diagnostics (status, logs, env vars, deployments). Accepts UUID, name, or domain (e.g., "stuartmason.co.uk" or "my-app")
- `find_issues` - Scan entire infrastructure for unhealthy apps, databases, services, and unreachable servers

### Servers

- `list_servers` - List all servers (returns summary)

### Projects

- `projects` - Manage projects with `action: list|get|create|update` (delete removed in this fork)

### Environments

- `environments` - Manage environments with `action: list|get|create` (delete removed in this fork)

### Applications

- `list_applications` - List all applications (returns summary)
- `application_logs` - Get application logs
- `application` - Create or update apps with `action: create_public|create_github|create_key|create_dockerimage|create_dockerfile|update` (delete and delete_preview removed in this fork)
  - Deploy from public repos, private GitHub, SSH keys, Docker images, or a raw Dockerfile
  - Configure health checks (path, interval, retries, etc.)
- `env_vars` - Manage env vars with `resource: application|service|database, action: list|create|update|delete|bulk_update`
- `control` - Start/stop/restart with `resource: application|database|service, action: start|stop|restart`

### Deployments

- `list_deployments` - List running deployments (returns summary)
- `deploy` - Deploy by tag or UUID
- `deployment` - Manage deployments with `action: get|cancel|list_for_app` (supports `lines` and `page` params for paginated log output with `logs_meta`)

## Why Coolify MCP?

- **Context-Optimized**: Responses are 90-99% smaller than raw API, preventing context window exhaustion
- **Smart Lookup**: Find apps by domain (`stuartmason.co.uk`), not just UUIDs
- **Production Ready**: 98%+ test coverage, TypeScript strict mode, comprehensive error handling
- **Hardened**: this fork exposes exactly 15 tools at the registration level — no delete/batch-ops/cloud-provisioning/docs-search surface, regardless of gateway configuration

## Related Links

- [stumason.dev](https://stumason.dev) - Author's site
- [MCP Registry](https://registry.modelcontextprotocol.io) - Find this server as `io.github.StuMason/coolify`
- [Coolify](https://coolify.io/) - The open-source & self-hostable Heroku/Netlify/Vercel alternative
- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol powering AI tool integrations

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.

## Support

- [GitHub Issues](https://github.com/StuMason/coolify-mcp/issues)
- [Coolify Community](https://coolify.io/docs/contact)

---

<p align="center">
  Built by <a href="https://stumason.dev">Stu Mason</a> · If you find this useful, please ⭐ star the repo!
</p>
