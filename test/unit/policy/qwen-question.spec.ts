import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { encodeQwenAnswer, isQwenUserQuestion, qwenUserQuestions } from '../../../src/domain/policy/qwen-question.ts'
import { isQwenTaskWakeStep } from '../../../src/host/composition/profile-adapter.ts'
import { qwenTaskCompletion, qwenTaskSnapshots } from '../../../src/runtime/session/qwen-background.ts'

function request(toolCall: Partial<acp.ToolCallUpdate>): acp.RequestPermissionRequest {
  return {
    sessionId: 's',
    options: [{ optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' }, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }],
    toolCall: { toolCallId: 'q', ...toolCall },
  }
}

const QUESTIONS = [{ question: 'Pick one?', header: 'One', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: 'bee' }] }]

describe('Qwen question parsing', () => {
  it('recognises the question by Qwen metadata only', () => {
    expect(isQwenUserQuestion(request({ _meta: { qwenInteractionKind: 'user_question' } }))).toBe(true)
    expect(isQwenUserQuestion(request({ _meta: { toolName: 'ask_user_question' } }))).toBe(true)
    expect(isQwenUserQuestion(request({ rawInput: { questions: QUESTIONS } }))).toBe(false)
  })

  it('prefers _meta.qwenQuestions and falls back to rawInput.questions', () => {
    expect(qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: QUESTIONS } }))).toEqual([
      { question: 'Pick one?', header: 'One', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: 'bee' }] },
    ])
    expect(qwenUserQuestions(request({ _meta: { toolName: 'ask_user_question' }, rawInput: { questions: QUESTIONS } }))).toHaveLength(1)
  })

  it('fails closed on malformed or ambiguous questions', () => {
    const dup = [{ question: 'Q?', options: [{ label: 'A' }, { label: 'A' }] }]
    expect(qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: dup } }))).toBeUndefined()
    expect(qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: [] } }))).toBeUndefined()
    expect(qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: [{ options: [] }] } }))).toBeUndefined()
  })

  it('encodes answers like the Qwen TUI', () => {
    const single = { question: 'Q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
    const multi = { ...single, multiSelect: true }
    expect(encodeQwenAnswer(single, { selected: ['B'] })).toBe('B')
    expect(encodeQwenAnswer(single, { selected: [], custom: ' other ' })).toBe('other')
    expect(encodeQwenAnswer(multi, { selected: ['A', 'B'], custom: 'C' })).toBe('A, B, C')
    expect(encodeQwenAnswer(multi, { selected: ['unknown'] })).toBeUndefined()
  })
})

describe('Qwen background-task helpers', () => {
  const message = (kind: string, text: string) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind } }) as never

  it('adopts only steps made of Qwen task completion notices', () => {
    const notice = message('tool-jobs', 'background job acp-qwen-task-3 (acp-qwen-task: npm test) finished [status: completed]. Read its output with job_output.')
    expect(isQwenTaskWakeStep([notice])).toBe(true)
    expect(isQwenTaskWakeStep([notice, message('runtime-context', 'ctx')])).toBe(true)
    expect(isQwenTaskWakeStep([notice, message('user', 'hi')])).toBe(false)
    expect(isQwenTaskWakeStep([message('tool-jobs', 'background job bash-1 (bash: ls) finished')])).toBe(false)
    expect(isQwenTaskWakeStep([])).toBe(false)
  })

  it('parses completion notifications and task snapshots defensively', () => {
    expect(qwenTaskCompletion({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' },
      _meta: { source: 'background_task_completed', backgroundTask: { taskId: 't1', status: 'failed', kind: 'agent' } } } } as never))
      .toEqual({ taskId: 't1', kind: 'agent', status: 'failed', text: 'done' })
    expect(qwenTaskCompletion({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } } as never)).toBeUndefined()
    expect(qwenTaskSnapshots({ tasks: [{ id: 'a', kind: 'shell', status: 'running', label: '' , description: 'desc' }, { id: 1 }] }))
      .toEqual([{ id: 'a', kind: 'shell', status: 'running', label: 'desc' }])
    expect(qwenTaskSnapshots(null)).toBeUndefined()
  })
})
