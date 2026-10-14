# claude-code-timesheet-mcp

MCP server that exposes local Claude Code session activity (`~/.claude/projects`) for time tracking. Returns metadata only: timestamps, repository, branch, Jira keys, session titles.

## Tools

- `get_work_sessions` – activity blocks and work periods per day
- `compute_time_entries` – deterministic daily time entries (meetings, overlaps, quarter-hour rounding)
- `get_session_prompts` – truncated user prompts of a session

## Run

Requires Node.js 22.9+ and [ngrok](https://ngrok.com).

```bash
npm install
cp .env.example .env   # set MCP_TOKEN (openssl rand -hex 32) and NGROK_URL
npm start              # server + tunnel
```

MCP endpoint: `https://<NGROK_URL>/mcp`, header `Authorization: Bearer <MCP_TOKEN>`.

## Mitigate AI Platform setup

1. In a [Mitigate AI Platform](https://ai.mitigate.dev) workspace, add the connectors: Google Calendar, GitHub, Atlassian (Jira), Harvest.
2. Add an MCP server with the endpoint and header above.
3. Enable all three tools (they start disabled) and set them to auto-approve; they are read-only.
4. Create a manually triggered workflow with `workflow-prompt.example.txt` as its prompt, after filling in its `CONFIGURATION` section (Jira prefix and repository → Harvest project).
5. Run it (optionally with a date, `YYYY-MM-DD`), review the draft in the chat (`drop 3`, `3 = 0.5`, `3 -> ABC-123`, …) and reply `approve` to create the Harvest entries.

The tunnel only works while your computer is awake and `npm start` is running.
