import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')
const TIME_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone
const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g
const JIRA_KEY_FALSE_POSITIVES = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'CVE', 'TLS', 'AES', 'COVID', 'GPT', 'ES'])
const PROMPT_PREVIEW_LENGTH = 200

const repoRootCache = new Map()

const projectName = (cwd) => {
  if (!cwd) return null
  if (!repoRootCache.has(cwd)) {
    let directory = cwd
    while (directory !== dirname(directory) && !existsSync(join(directory, '.git'))) directory = dirname(directory)
    repoRootCache.set(cwd, basename(directory === dirname(directory) ? cwd : directory))
  }
  return repoRootCache.get(cwd)
}

const localDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)

const extractJiraKeys = (text) =>
  [...(text || '').matchAll(JIRA_KEY_PATTERN)]
    .map((match) => match[0])
    .filter((key) => !JIRA_KEY_FALSE_POSITIVES.has(key.split('-')[0]))

const promptText = (entry) => {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null
  const content = entry.message?.content
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content) && content.every((part) => part.type === 'text')
      ? content.map((part) => part.text).join('\n')
      : null
  if (!raw || raw.startsWith('<local-command') || raw.startsWith('Caveat:')) return null
  const commandName = raw.match(/<command-name>(.*?)<\/command-name>/)?.[1]
  if (commandName) return commandName
  return raw
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted]')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null
}

const readSessionFile = async (filePath) => {
  const session = {
    session_id: basename(filePath, '.jsonl'),
    cwd: null,
    branches: new Set(),
    title: null,
    activity: [],
    prompts: [],
  }
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  for await (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'ai-title' && entry.aiTitle) session.title = entry.aiTitle
    if (entry.type === 'summary' && entry.summary && !session.title) session.title = entry.summary
    if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.timestamp || entry.isSidechain) continue
    const timestamp = new Date(entry.timestamp)
    const branch = entry.gitBranch && entry.gitBranch !== 'HEAD' ? entry.gitBranch : null
    session.activity.push({ at: timestamp, branch })
    if (entry.cwd) session.cwd = entry.cwd
    if (branch) session.branches.add(branch)
    const text = promptText(entry)
    if (text) session.prompts.push({ at: timestamp, text })
  }
  session.activity.sort((a, b) => a.at - b.at)
  return session
}

const listSessionFiles = async (modifiedSince) => {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
  const files = []
  for (const projectDir of projectDirs.filter((dirent) => dirent.isDirectory())) {
    const projectPath = join(PROJECTS_DIR, projectDir.name)
    for (const fileName of await readdir(projectPath)) {
      if (!fileName.endsWith('.jsonl')) continue
      const filePath = join(projectPath, fileName)
      if ((await stat(filePath)).mtime >= modifiedSince) files.push(filePath)
    }
  }
  return files
}

const splitIntoBlocks = (activity, gapMs, leadInMs) => {
  const blocks = []
  for (const { at, branch } of activity) {
    const lastBlock = blocks.at(-1)
    if (lastBlock && at - lastBlock.end <= gapMs) {
      lastBlock.end = at
    } else {
      blocks.push({ start: new Date(at.getTime() - leadInMs), end: at, branches: new Set() })
    }
    if (branch) blocks.at(-1).branches.add(branch)
  }
  return blocks
}

const mergeIntervals = (intervals, gapMs) => {
  const merged = []
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const lastInterval = merged.at(-1)
    if (lastInterval && interval.start - lastInterval.end <= gapMs) {
      lastInterval.end = new Date(Math.max(lastInterval.end, interval.end))
    } else {
      merged.push({ start: interval.start, end: interval.end })
    }
  }
  return merged.map((interval) => ({ ...interval, minutes: Math.round((interval.end - interval.start) / 60000) }))
}

const sumMinutes = (intervals) => intervals.reduce((total, interval) => total + interval.minutes, 0)

const localTime = (date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)

const collectBlocks = async ({ dateFrom, dateTo, gapMinutes, leadInMinutes }) => {
  const rangeStart = new Date(`${dateFrom}T00:00:00Z`)
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1)
  const sessions = await Promise.all((await listSessionFiles(rangeStart)).map(readSessionFile))

  const blocks = []
  for (const session of sessions) {
    const sessionBlocks = splitIntoBlocks(session.activity, gapMinutes * 60000, leadInMinutes * 60000)
    sessionBlocks.forEach((block, blockIndex) => {
      const date = localDate(block.start)
      if (date < dateFrom || date > dateTo) return
      const blockPrompts = session.prompts.filter((prompt) => prompt.at >= block.start && prompt.at <= block.end)
      const branchKeys = [...block.branches].flatMap(extractJiraKeys)
      const titleKeys = extractJiraKeys(session.title)
      const promptKeys = blockPrompts.flatMap((prompt) => extractJiraKeys(prompt.text))
      blocks.push({
        block_id: `${session.session_id.slice(0, 8)}-${blockIndex}`,
        date,
        start: block.start,
        end: block.end,
        duration_minutes: Math.round((block.end - block.start) / 60000),
        session_id: session.session_id,
        title: session.title,
        project: projectName(session.cwd),
        branches: [...block.branches],
        jira_key: branchKeys[0] || titleKeys[0] || promptKeys[0] || null,
        jira_keys: [...new Set([...branchKeys, ...titleKeys, ...promptKeys])],
        prompt_count: blockPrompts.length,
      })
    })
  }
  for (const block of blocks.filter((candidate) => !candidate.jira_key)) {
    const sessionKeys = blocks
      .filter((other) => other.session_id === block.session_id && other.jira_key)
      .map((other) => other.jira_key)
    const mostFrequentKey = Object.entries(Object.groupBy(sessionKeys, (key) => key))
      .sort((a, b) => b[1].length - a[1].length)[0]?.[0]
    if (mostFrequentKey) {
      block.jira_key = mostFrequentKey
      block.jira_key_inherited_from_session = true
    }
  }
  return blocks.sort((a, b) => a.start - b.start)
}

export const getWorkSessions = async ({ dateFrom, dateTo, gapMinutes = 30, leadInMinutes = 5 }) => {
  const blocks = await collectBlocks({ dateFrom, dateTo, gapMinutes, leadInMinutes })

  const days = Object.entries(Object.groupBy(blocks, (block) => block.date)).map(([date, dayBlocks]) => {
    const workPeriods = mergeIntervals(dayBlocks, gapMinutes * 60000)
    return {
      date,
      first_activity: workPeriods[0].start,
      last_activity: workPeriods.at(-1).end,
      work_minutes: sumMinutes(workPeriods),
      claude_minutes: sumMinutes(mergeIntervals(dayBlocks, 0)),
      work_periods: workPeriods,
      blocks: dayBlocks.map(({ date: _date, ...block }) => block),
    }
  })

  return { time_zone: TIME_ZONE, gap_minutes: gapMinutes, lead_in_minutes: leadInMinutes, days }
}

const shareByKey = (keys) => {
  const shares = new Map()
  for (const key of keys) shares.set(key, (shares.get(key) || 0) + 1 / keys.length)
  return shares
}

const roundToStep = (entries, stepMinutes) => {
  const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)
  const targetSteps = Math.round(totalMinutes / stepMinutes)
  const withFloors = entries.map((entry) => ({
    entry,
    steps: Math.floor(entry.minutes / stepMinutes),
    remainder: entry.minutes / stepMinutes - Math.floor(entry.minutes / stepMinutes),
  }))
  let missingSteps = targetSteps - withFloors.reduce((total, item) => total + item.steps, 0)
  for (const item of [...withFloors].sort((a, b) => b.remainder - a.remainder)) {
    if (missingSteps <= 0) break
    item.steps += 1
    missingSteps -= 1
  }
  return withFloors.map(({ entry, steps }) => ({ ...entry, rounded_minutes: steps * stepMinutes }))
}

export const computeTimeEntries = async ({
  date,
  meetings = [],
  attributions = {},
  gapMinutes = 30,
  leadInMinutes = 5,
  roundingMinutes = 15,
  minEntryMinutes = 5,
}) => {
  const blocks = await collectBlocks({ dateFrom: date, dateTo: date, gapMinutes, leadInMinutes })
  const blockKey = (block) =>
    attributions[block.block_id] || block.jira_key || `UNATTRIBUTED: ${block.project} - ${block.title || block.branches[0] || block.session_id.slice(0, 8)}`
  const dayMeetings = meetings.map((meeting) => ({
    start: new Date(meeting.start),
    end: new Date(meeting.end),
    title: meeting.title,
    key: meeting.key || `MEETING: ${meeting.title}`,
  }))
  if (blocks.length === 0 && dayMeetings.length === 0) return { date, time_zone: TIME_ZONE, entries: [], note: 'No activity' }

  const workPeriods = mergeIntervals([...blocks, ...dayMeetings], gapMinutes * 60000)
  const entries = new Map()
  const entryFor = (key) => {
    if (!entries.has(key)) {
      entries.set(key, { key, minutes: 0, first_start: null, block_ids: new Set(), session_titles: new Set(), branches: new Set(), projects: new Set(), meetings: new Set() })
    }
    return entries.get(key)
  }
  const overlaps = []
  const recordOverlap = (minuteStart, description) => {
    const lastOverlap = overlaps.at(-1)
    if (lastOverlap && lastOverlap.description === description && lastOverlap.end.getTime() === minuteStart.getTime()) {
      lastOverlap.end = new Date(minuteStart.getTime() + 60000)
    } else {
      overlaps.push({ start: minuteStart, end: new Date(minuteStart.getTime() + 60000), description })
    }
  }

  let previousShares = null
  const pendingMinutes = []
  const assign = (shares, minuteStart) => {
    for (const [key, share] of shares) {
      const entry = entryFor(key)
      entry.minutes += share
      if (!entry.first_start || minuteStart < entry.first_start) entry.first_start = minuteStart
    }
  }

  for (const period of workPeriods) {
    const periodStart = Math.floor(period.start.getTime() / 60000) * 60000
    for (let minute = periodStart; minute < period.end.getTime(); minute += 60000) {
      const minuteStart = new Date(minute)
      const sample = minute + 30000
      const activeMeetings = dayMeetings.filter((meeting) => meeting.start <= sample && meeting.end > sample)
      const activeBlocks = blocks.filter((block) => block.start <= sample && block.end >= sample)
      for (const block of activeBlocks) {
        const entry = entryFor(blockKey(block))
        entry.block_ids.add(block.block_id)
        if (block.title) entry.session_titles.add(block.title)
        block.branches.forEach((branch) => entry.branches.add(branch))
        if (block.project) entry.projects.add(block.project)
      }
      activeMeetings.forEach((meeting) => entryFor(meeting.key).meetings.add(`${meeting.title} ${localTime(meeting.start)}-${localTime(meeting.end)}`))

      let shares
      if (activeMeetings.length > 0) {
        shares = shareByKey(activeMeetings.map((meeting) => meeting.key))
        const displacedKeys = [...new Set(activeBlocks.map(blockKey))].filter((key) => !shares.has(key))
        if (displacedKeys.length > 0) recordOverlap(minuteStart, `meeting ${[...shares.keys()].join(', ')} over ${displacedKeys.join(', ')}`)
      } else if (activeBlocks.length > 0) {
        shares = shareByKey(activeBlocks.map(blockKey))
        if (shares.size > 1) recordOverlap(minuteStart, `parallel ${[...shares.keys()].join(', ')}`)
      } else if (previousShares) {
        shares = previousShares
      } else {
        pendingMinutes.push(minuteStart)
        continue
      }
      for (const pendingMinute of pendingMinutes.splice(0)) assign(shares, pendingMinute)
      assign(shares, minuteStart)
      previousShares = shares
    }
  }

  const allEntries = [...entries.values()].filter((entry) => entry.minutes > 0)
  const keptEntries = allEntries.filter((entry) => entry.minutes >= minEntryMinutes)
  const droppedEntries = allEntries.filter((entry) => entry.minutes < minEntryMinutes)
  const workMinutes = Math.round(allEntries.reduce((total, entry) => total + entry.minutes, 0))

  const roundedEntries = roundToStep(keptEntries, roundingMinutes).sort((a, b) => a.first_start - b.first_start)

  return {
    date,
    time_zone: TIME_ZONE,
    work_minutes: workMinutes,
    entries_minutes: Math.round(keptEntries.reduce((total, entry) => total + entry.minutes, 0)),
    rounded_total_hours: roundedEntries.reduce((total, entry) => total + entry.rounded_minutes, 0) / 60,
    day_span: `${localTime(workPeriods[0].start)}-${localTime(workPeriods.at(-1).end)}`,
    work_periods: workPeriods.map((period) => `${localTime(period.start)}-${localTime(period.end)}`),
    entries: roundedEntries.map((entry) => ({
      key: entry.key,
      kind: entry.key.startsWith('UNATTRIBUTED') ? 'unattributed' : entry.key.startsWith('MEETING') ? 'meeting' : 'jira',
      hours: entry.rounded_minutes / 60,
      minutes: Math.round(entry.minutes),
      first_start: localTime(entry.first_start),
      block_ids: [...entry.block_ids],
      session_titles: [...entry.session_titles],
      branches: [...entry.branches],
      projects: [...entry.projects],
      meetings: [...entry.meetings],
    })),
    dropped_entries: droppedEntries.map((entry) => ({ key: entry.key, minutes: Math.round(entry.minutes * 10) / 10 })),
    overlaps: overlaps.map((overlap) => ({
      time: `${localTime(overlap.start)}-${localTime(overlap.end)}`,
      minutes: Math.round((overlap.end - overlap.start) / 60000),
      description: overlap.description,
    })),
  }
}

export const getSessionPrompts = async ({ sessionId }) => {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error('Invalid session_id')
  const files = (await listSessionFiles(new Date(0))).filter((filePath) => basename(filePath, '.jsonl') === sessionId)
  if (files.length === 0) throw new Error(`Session ${sessionId} not found`)
  const session = await readSessionFile(files[0])
  return {
    session_id: session.session_id,
    title: session.title,
    project: projectName(session.cwd),
    branches: [...session.branches],
    prompts: session.prompts.map((prompt) => ({
      at: prompt.at,
      text: prompt.text.length > PROMPT_PREVIEW_LENGTH ? `${prompt.text.slice(0, PROMPT_PREVIEW_LENGTH)}…` : prompt.text,
    })),
  }
}
