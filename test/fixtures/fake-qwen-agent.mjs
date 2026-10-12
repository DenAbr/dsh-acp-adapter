// Minimal Qwen Code ACP stand-in (wire shapes from qwen-code 0.25 acp-integration).
// Prompt text selects the scenario:
//   "ask"        -> ask_user_question via session/request_permission, echoes `answers`
//   "background" -> finishes the prompt, then completes task bg-1 out of turn,
//                   announces `_qwencode/start_turn`, streams a reply, `_qwencode/end_turn`
//   "background-ask" -> as background, but the Qwen-initiated turn asks a question first
//   anything else -> plain reply
// FAKE_QWEN_START_TIMEOUT_MS bounds the wait for the start_turn answer (Qwen: 2 s).
let buffer = ''
let nextId = 1000
const pending = new Map()
const SESSION = 'qwen-session'
const tasks = [{ kind: 'shell', id: 'bg-1', label: 'sleep 1 && echo done', status: 'running', startTime: 1 }]
const cancelled = []
let backgroundTurn
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})
const update = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update } })
const text = (value, meta) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value }, ...(meta === undefined ? {} : { _meta: meta }) })

const QUESTIONS = [
  { question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] },
  { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
]

async function ask(meta) {
  const response = await request('session/request_permission', {
    sessionId: SESSION,
    options: [{ optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' }, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }],
    toolCall: {
      toolCallId: 'question-1', status: 'pending', title: 'Ask user 2 questions', content: [], locations: [], kind: 'think',
      rawInput: { questions: QUESTIONS, metadata: { source: 'test' } },
      _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question', qwenQuestions: QUESTIONS },
    },
    ...(meta === undefined ? {} : { _meta: meta }),
  })
  return response
}

async function runBackground(withQuestion) {
  await new Promise(resolve => setTimeout(resolve, 150))
  tasks[0].status = 'completed'
  text('Background shell bg-1 completed: done', {
    source: 'background_task_completed', qwenDiscreteMessage: true,
    backgroundTask: { taskId: 'bg-1', status: 'completed', kind: 'shell', sourceTurnId: 't0' },
  })
  const turnId = `${SESSION}########notification1`
  const timeoutMs = Number(process.env.FAKE_QWEN_START_TIMEOUT_MS ?? 2000)
  const answer = await Promise.race([
    request('_qwencode/start_turn', { sessionId: SESSION, source: 'background_notification', turnId, taskId: 'bg-1', kind: 'shell', label: 'sleep 1 && echo done', startedAt: Date.now() }),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ])
  const proceed = answer?.result?.accepted === true || answer?.error?.code === -32601
  text(`start_turn:${JSON.stringify(answer?.result ?? answer?.error?.code ?? answer)}`, { source: 'fake-diagnostic' })
  if (!proceed) return
  const meta = { backgroundTurn: { turnId, taskId: 'bg-1', kind: 'shell' } }
  backgroundTurn = { turnId, ended: false }
  if (withQuestion) {
    const response = await ask(meta)
    text(`bg-answers:${JSON.stringify(response?.result?.answers ?? null)}`, meta)
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  if (backgroundTurn.ended) return
  text('The background command printed done.', { ...meta, source: 'background_notification_response' })
  backgroundTurn.ended = true
  send({ jsonrpc: '2.0', method: '_qwencode/end_turn', params: { sessionId: SESSION, reason: 'end_turn', turnId, source: 'background_notification' } })
}

// Qwen cron/loop turn: no start/end markers, only the echoed prompt and
// usage chunks closing each model round.
async function runCron(respond) {
  if (respond === undefined) await new Promise(resolve => setTimeout(resolve, 100))
  const usage = () => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 } })
  update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'check the build' }, _meta: { source: 'cron' } })
  text('cron working')
  usage()
  // "schedule-inline": Qwen drains cron before answering the prompt.
  respond?.()
  update({ sessionUpdate: 'tool_call', toolCallId: 'cron-tool', title: 'Run build', kind: 'execute', status: 'pending', rawInput: { command: 'npm run build' } })
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-tool', status: 'in_progress' })
  await new Promise(resolve => setTimeout(resolve, 300))
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-tool', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 200))
  text('cron done')
  usage()
}

async function onPrompt(message) {
  const prompt = message.params.prompt.map(block => block.text ?? '').join(' ')
  if (prompt.includes('ask') && !prompt.includes('background')) {
    const response = await ask()
    text(`answers:${JSON.stringify(response?.result?.answers ?? null)} outcome:${JSON.stringify(response?.result?.outcome ?? null)}`)
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  text(`echo:${prompt}`)
  if (prompt.includes('schedule-inline')) {
    void runCron(() => send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }))
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  if (prompt.includes('background')) void runBackground(prompt.includes('background-ask'))
  if (prompt.includes('schedule')) void runCron()
}

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.method === undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
      continue
    }
    switch (message.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'qwen-code', title: 'Qwen Code', version: '0.25.1' }, agentCapabilities: { loadSession: true } } })
        break
      case 'session/new':
        send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION } })
        break
      case 'session/prompt':
        void onPrompt(message)
        break
      case 'session/cancel':
        if (backgroundTurn !== undefined && !backgroundTurn.ended) {
          backgroundTurn.ended = true
          send({ jsonrpc: '2.0', method: '_qwencode/end_turn', params: { sessionId: SESSION, reason: 'cancelled', turnId: backgroundTurn.turnId, source: 'background_notification' } })
        }
        break
      case 'qwen/status/session/tasks':
        send({ jsonrpc: '2.0', id: message.id, result: { v: 1, sessionId: SESSION, now: Date.now(), tasks } })
        break
      case 'qwen/control/session/task/cancel':
        cancelled.push(message.params)
        tasks[0].status = 'cancelled'
        send({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
        text('Background shell bg-1 cancelled', { source: 'background_task_completed', backgroundTask: { taskId: message.params.taskId, status: 'cancelled', kind: message.params.taskKind } })
        break
      default:
        if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
