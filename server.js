import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { computeTimeEntries, getSessionPrompts, getWorkSessions } from './sessions.js'

const PORT = Number(process.env.PORT || 8787)
const TOKEN = process.env.MCP_TOKEN

if (!TOKEN || TOKEN.length < 32) {
  console.error('Set MCP_TOKEN (at least 32 characters), e.g. MCP_TOKEN=$(openssl rand -hex 32)')
  process.exit(1)
}

const isDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const jsonResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })

const buildServer = () => {
  const server = new McpServer({ name: 'claude-code-sessions', version: '1.0.0' })

  server.registerTool(
    'get_work_sessions',
    {
      title: 'Claude Code work sessions',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Returns Claude Code activity per local day. work_periods merge all sessions, bridging idle gaps up to ' +
        'gap_minutes (the user keeps working between prompts); work_minutes is their total and is the day\'s working ' +
        'time from Claude alone. claude_minutes counts only time inside blocks. Each block is one session\'s ' +
        'continuous activity with project (git repo), branches active during the block, Jira keys from those ' +
        'branches/title/prompts, and session title. Blocks from parallel sessions overlap, so never sum block ' +
        'durations. A repo can be shared across customers, so attribute time by Jira project prefix ' +
        '(e.g. ABC- in ABC-123) rather than by project.',
      inputSchema: {
        date_from: isDate.describe('First local date, inclusive (YYYY-MM-DD)'),
        date_to: isDate.describe('Last local date, inclusive (YYYY-MM-DD)'),
        gap_minutes: z.number().int().min(1).max(120).optional().describe('Idle gaps up to this long count as work (default 30)'),
      },
    },
    async ({ date_from, date_to, gap_minutes }) =>
      jsonResult(await getWorkSessions({ dateFrom: date_from, dateTo: date_to, gapMinutes: gap_minutes })),
  )

  server.registerTool(
    'compute_time_entries',
    {
      title: 'Compute time entries',
      description:
        'Deterministically builds the day\'s time entries from Claude Code blocks plus the meetings you pass in. ' +
        'Meetings take priority over Claude blocks, parallel blocks split time equally, bridged gaps go to the ' +
        'previous activity, entries under 5 minutes are dropped, and hours are rounded to quarter hours so the ' +
        'entries add up to the rounded total. Do not recalculate its numbers. Blocks without a Jira key come back ' +
        'as UNATTRIBUTED entries listing their block_ids; resolve them and call again with attributions.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        date: isDate.describe('Local date (YYYY-MM-DD)'),
        meetings: z
          .array(
            z.object({
              start: z.string().describe('ISO 8601 with offset, e.g. 2026-10-13T13:00:00+03:00'),
              end: z.string().describe('ISO 8601 with offset'),
              title: z.string(),
              key: z.string().optional().describe('Jira key or entry label this meeting belongs to'),
            }),
          )
          .optional()
          .describe('Calendar meetings attended on the day'),
        attributions: z
          .record(z.string(), z.string())
          .optional()
          .describe('Map of block_id to Jira key or label, for blocks you resolved yourself'),
      },
    },
    async ({ date, meetings, attributions }) => jsonResult(await computeTimeEntries({ date, meetings, attributions })),
  )

  server.registerTool(
    'get_session_prompts',
    {
      title: 'Claude Code session prompts',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Returns the user prompts of one session (truncated to 200 characters each), useful for writing time entry notes.',
      inputSchema: {
        session_id: z.string().describe('session_id from get_work_sessions'),
      },
    },
    async ({ session_id }) => jsonResult(await getSessionPrompts({ sessionId: session_id })),
  )

  return server
}

const isAuthorized = (request) => {
  const header = request.headers.authorization || ''
  const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : String(request.query.token || ''))
  const expected = Buffer.from(TOKEN)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

const app = express()
app.use(express.json())

app.get('/health', (_request, response) => response.json({ ok: true }))

app.use('/mcp', (request, response, next) => {
  if (isAuthorized(request)) return next()
  console.warn(`${new Date().toISOString()} rejected ${request.method} /mcp from ${request.ip}`)
  response.status(401).json({ error: 'Unauthorized' })
})

app.post('/mcp', async (request, response) => {
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  response.on('close', () => {
    transport.close()
    server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(request, response, request.body)
    console.log(`${new Date().toISOString()} ${request.body?.method} ${request.body?.params?.name || ''}`)
  } catch (error) {
    console.error(error)
    if (!response.headersSent) {
      response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  }
})

const methodNotAllowed = (_request, response) =>
  response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

app.listen(PORT, '127.0.0.1', () => console.log(`MCP server on http://127.0.0.1:${PORT}/mcp`))
