# surge-mcp-server

MCP server for [surge.sh](https://surge.sh) — deploy static websites instantly via AI agents.

## Tools

### `surge_login`
Login to surge.sh. Credentials persist to `~/.netrc` for subsequent calls.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | yes | Surge account email |
| `password` | string | yes | Surge account password |

Credentials can also be set via environment variables: `SURGE_EMAIL` / `SURGE_PASSWORD`.

### `surge_deploy`
Deploy a static site directory. Custom domain or random.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `directory` | string | yes | Path to the directory to deploy |
| `domain` | string | no | Custom subdomain (e.g., `my-site.surge.sh`). Random if omitted. |

### `surge_teardown`
Remove a deployed site.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | The surge.sh domain to tear down |

## Usage

### Local development

```bash
npm install
npm run build
node build/index.js
```

### Inspect with MCP Inspector

```bash
npm run inspector
```

### Register in AgentX marketplace

```json
{
  "mcpServers": {
    "surge": {
      "command": "node",
      "args": ["build/index.js"]
    }
  }
}
```

## Requirements

- Node.js >= 18
- surge CLI (`npm install -g surge`) — auto-installed on startup if missing
