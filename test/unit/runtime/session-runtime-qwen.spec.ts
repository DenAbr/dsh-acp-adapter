import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { createQwenQuestionHandler } from '../../../src/domain/policy/qwen-question.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'
import type { QwenTaskJobHooks, QwenTaskJobOutcome, QwenTaskJobStarter } from '../../../src/runtime/session/qwen-background.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'fake-qwen-agent.mjs')

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const answeringQuestions: AcpNativeUserQuestionService = {
  async ask(request) {
    return {
      answers: request.questions.map(question => question.multiSelect === true
        ? { id: question.id, selected: ['X', 'Y'], custom: 'my own' }
        : { id: question.id, selected: ['B'] }),
    }
  },
}

function createRuntime(extra: Partial<AcpSessionRuntimeOptions> = {}, env: Record<string, string> = {}): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-qwen-'))
  roots.push(root)
  const argv = [process.execPath, AGENT]
  const runtime = new AcpSessionRuntime({
    profileId: 'qwen',
    config: { command: process.execPath, args: [AGENT], env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    onPermissionRequest: async () => { throw new Error('a Qwen question must not reach the approval bridge') },
    onQwenQuestion: createQwenQuestionHandler({ userQuestions: answeringQuestions, getAgent: () => ({}) }),
    agentTurnWaitMs: 2_000,
    ...extra,
  })
  runtimes.push(runtime)
  return runtime
}

function texts(notifications: readonly AcpSessionNotification[]): string[] {
  return notifications.flatMap(notification => {
    const update = notification.update
    return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  })
}

interface RecordedJob { label: string; hooks: QwenTaskJobHooks; outcome: Promise<QwenTaskJobOutcome>; cancelled: boolean }

function recordingJobs(): { starter: QwenTaskJobStarter; jobs: RecordedJob[]; next(): Promise<RecordedJob> } {
  const jobs: RecordedJob[] = []
  const waiters: Array<(job: RecordedJob) => void> = []
  const starter: QwenTaskJobStarter = (label, run) => {
    const hooks = run()
    const job: RecordedJob = { label, hooks, outcome: hooks.done, cancelled: false }
    jobs.push(job)
    waiters.shift()?.(job)
    return { cancel: () => { job.cancelled = true; hooks.cancel() } }
  }
  return {
    starter, jobs,
    next: () => new Promise<RecordedJob>(resolve => { waiters.push(resolve) }),
  }
}

describe('Qwen Code ask_user_question', () => {
  it('answers through the native question card with Qwen `answers`, never through approval', async () => {
    const runtime = createRuntime()
    const updates: AcpSessionNotification[] = []
    const response = await runtime.prompt([{ type: 'text', text: 'ask' }], notification => { updates.push(notification) })
    expect(response.stopReason).toBe('end_turn')
    const reply = texts(updates).find(text => text.startsWith('answers:'))
    expect(reply).toBe('answers:{"0":"B","1":"X, Y, my own"} outcome:{"outcome":"selected","optionId":"proceed_once"}')
  })

  it('declines the question (cancelled) when the user dismisses it', async () => {
    const runtime = createRuntime({
      onQwenQuestion: createQwenQuestionHandler({ userQuestions: { ask: async () => { throw new Error('dismissed') } }, getAgent: () => ({}) }),
    })
    const updates: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'ask' }], notification => { updates.push(notification) })
    expect(texts(updates)).toContain('answers:null outcome:{"outcome":"cancelled"}')
  })
})

describe('Qwen Code background tasks', () => {
  it('mirrors running tasks as jobs and adopts the Qwen-initiated turn after the wake-up', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    const first: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'background' }], notification => { first.push(notification) })
    const job = await mirrored
    expect(job.label).toBe('sleep 1 && echo done')
    // Qwen announces its own turn: the mirrored job settles unawaited (wake-up).
    const outcome = await job.outcome
    expect(outcome).toMatchObject({ status: 'completed', silent: false, result: 'Background shell bg-1 completed: done' })
    const adopted: AcpSessionNotification[] = []
    const response = await runtime.prompt([{ type: 'text', text: 'background job acp-qwen-task-1 finished' }], notification => { adopted.push(notification) }, undefined, undefined, { adoptAgentTurn: true })
    expect(response.stopReason).toBe('end_turn')
    expect(texts(adopted)).toContain('The background command printed done.')
    // The notice itself was never sent to Qwen as a prompt.
    expect(texts(adopted).some(text => text.startsWith('echo:'))).toBe(false)
    expect(texts(adopted)).not.toContain('Background shell bg-1 completed: done')
  })

  it('holds a question from an unadopted Qwen turn until the woken host turn adopts it', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background-ask' }], () => undefined)
    await (await mirrored).outcome
    // Simulate a slow wake-up: Qwen is already asking.
    await new Promise(resolve => setTimeout(resolve, 150))
    const adopted: AcpSessionNotification[] = []
    const response = await runtime.prompt([{ type: 'text', text: 'wake' }], notification => { adopted.push(notification) }, undefined, undefined, { adoptAgentTurn: true })
    expect(response.stopReason).toBe('end_turn')
    expect(texts(adopted)).toContain('bg-answers:{"0":"B","1":"X, Y, my own"}')
    expect(texts(adopted)).toContain('The background command printed done.')
  })

  it('cancels an adopted Qwen turn on host stop', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background-ask' }], () => undefined)
    await (await mirrored).outcome
    const controller = new AbortController()
    const adopting = runtime.prompt([{ type: 'text', text: 'wake' }], () => undefined, controller.signal, undefined, { adoptAgentTurn: true })
    setTimeout(() => controller.abort(), 10)
    expect((await adopting).stopReason).toBe('cancelled')
    // The runtime accepts a new user prompt afterwards.
    expect((await runtime.prompt([{ type: 'text', text: 'hello' }], () => undefined)).stopReason).toBe('end_turn')
  })

  it('falls back to an ordinary prompt when Qwen does not announce a turn', async () => {
    const runtime = createRuntime({ qwenTaskJobs: recordingJobs().starter, agentTurnWaitMs: 50 })
    const updates: AcpSessionNotification[] = []
    const response = await runtime.prompt([{ type: 'text', text: 'notice' }], notification => { updates.push(notification) }, undefined, undefined, { adoptAgentTurn: true })
    expect(response.stopReason).toBe('end_turn')
    expect(texts(updates)).toContain('echo:notice')
  })

  it('maps a job kill to Qwen task cancellation and settles silently', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    // A plain prompt mirrors bg-1 without completing it.
    await runtime.prompt([{ type: 'text', text: 'hello' }], () => undefined)
    const job = await mirrored
    job.hooks.cancel()
    const outcome = await job.outcome
    expect(outcome).toMatchObject({ status: 'killed', silent: true })
  })

  it('leaves Qwen\'s unannounced fallback in place without a job registry', async () => {
    const runtime = createRuntime()
    const seen: AcpSessionNotification[] = []
    const all = new Promise<void>(resolve => {
      const runtimeWithUpdates = createRuntime({ onSessionUpdate: notification => {
        seen.push(notification)
        if (texts([notification]).some(text => text.startsWith('start_turn:'))) resolve()
      } })
      void runtimeWithUpdates.prompt([{ type: 'text', text: 'background' }], () => undefined)
    })
    await all
    expect(texts(seen)).toContain('start_turn:-32601')
    await runtime.close()
  })
})
