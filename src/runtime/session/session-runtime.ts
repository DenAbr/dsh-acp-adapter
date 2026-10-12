/**
 * Minimal ACP session owner used by the provider adapter.
 *
 * This is deliberately not a DSH Agent or AgentLoop.  It owns one ACP
 * connection and one ACP session for one DSH model route, while the stock DSH
 * loop remains responsible for turns, history, cancellation and UI.
 */
/// <reference types="node" />

import type * as acp from '@agentclientprotocol/sdk'
import { AcpClientConnection, supportsFork } from '../../protocol/v1/connection.ts'
import type { AcpConnectionSpec, AcpSpawnPlanView } from '../process/types.ts'
import type { SubprocessSeam } from '../process/subprocess.ts'
import type { AcpFileSystemHandlers } from '../client-capabilities/filesystem.ts'
import type { AcpTerminalHandlers } from '../client-capabilities/terminal.ts'
import { acpConfigOptionsSnapshot } from '../../protocol/v1/config-options.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import { waitWithin } from '../process/timeout.ts'
import type { AcpMcpLease } from './mcp-lease.ts'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'
import { isQwenUserQuestion } from '../../domain/policy/qwen-question.ts'
import { RequestError } from '@agentclientprotocol/sdk'
import type { QwenTurnEndParams, QwenTurnStartParams, QwenTurnStartResult } from '../../protocol/v1/types.ts'
import { QwenBackgroundTasks, qwenTaskCompletion, qwenTaskSnapshots, type QwenTaskJobStarter } from './qwen-background.ts'
/** Deliberately protocol-local: runtime restoration does not own persistence. */
export interface AcpRuntimeBindingRef { readonly agentSessionId: string }
export interface AcpRuntimeConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

export interface AcpRuntimeLaunch {
  readonly mcpLease?: AcpMcpLease
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly spawnPlan: AcpSpawnPlanView
}

export interface AcpRuntimeContextUsage {
  readonly used: number
  readonly size: number
  readonly cost?: { readonly amount: number; readonly currency: string } | null
}

export interface AcpSessionRuntimeOptions {
  readonly mcpKey?: () => unknown
  readonly createMcpLease?: (capabilities: acp.AgentCapabilities | undefined) => Promise<AcpMcpLease | undefined>
  readonly profileId: string
  /** Explicit runtime-bound gate for Claude's private draft extension. */
  readonly enableClaudeDraftSubagents?: boolean
  readonly config: AcpRuntimeConfig
  readonly subprocess: SubprocessSeam
  readonly cwd: string
  readonly prepareLaunch: (config: AcpRuntimeConfig, cwd: string) => Promise<AcpRuntimeLaunch>
  /** Optional host capability handlers, created after the native launch environment is known. */
  readonly createFileSystemHandlers?: (context: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => AcpFileSystemHandlers
  readonly createTerminalHandlers?: (context: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => AcpTerminalHandlers
  /** Replay/load notifications are staging-only; the DSH log remains authoritative. */
  readonly onSessionUpdate?: (notification: AcpSessionNotification) => void
  /** Host-owned approval bridge. The optional signal is the active prompt lifetime. */
  readonly onPermissionRequest?: (params: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse>
  readonly onPermissionCheck?: (check: AcpPermissionCheck, request: acp.RequestPermissionRequest) => Promise<void>
  /** Host-owned form elicitation bridge; URL elicitation is intentionally not advertised. */
  readonly onElicitationRequest?: (params: acp.CreateElicitationRequest, signal?: AbortSignal, hostToolName?: string, hostToolCall?: acp.ToolCallUpdate) => Promise<acp.CreateElicitationResponse>
  /** One-shot diagnostic for optional private capability degradation. */
  readonly onCapabilityDegraded?: (message: string) => void
  /** Grace period after `session/cancel` before the Agent process is closed. */
  readonly cancelGraceMs?: number
  /** Qwen `ask_user_question` bridge (permission request carrying questions + `answers`). */
  readonly onQwenQuestion?: (params: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse>
  /** Host job registry seam. Enables Qwen background-task mirroring and adoption of Qwen-initiated turns. */
  readonly qwenTaskJobs?: QwenTaskJobStarter
  /** How long an adopting host call waits for Qwen to announce its turn. */
  readonly agentTurnWaitMs?: number
}

/** Options for one `prompt()` call. */
export interface AcpPromptOptions {
  /**
   * The host turn was woken by a Qwen background-task notice: run the turn
   * Qwen has started by itself instead of sending `session/prompt`. Falls back
   * to an ordinary prompt when no such turn is announced in time.
   */
  readonly adoptAgentTurn?: boolean
}

/** One Agent-initiated (Qwen `_qwencode/start_turn`) turn. */
interface AgentTurn {
  readonly turnId: string
  readonly buffer: AcpSessionNotification[]
  listener: ((notification: AcpSessionNotification) => void) | undefined
  ended: string | undefined
  readonly endedPromise: Promise<string>
  readonly end: (reason: string) => void
}

const AGENT_TURN_BUFFER_MAX = 10_000
/** Upper bound for an Agent-initiated turn's permission request to wait for host adoption. */
const AGENT_TURN_ADOPTION_MAX_MS = 60_000
const ACP_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
const QWEN_AGENT_NAME = 'qwen-code'

/** A conforming Agent normally settles cancellation immediately; this only
 * bounds an Agent that ignores `session/cancel`. */
export const ACP_CANCEL_SETTLE_GRACE_MS = 5_000

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** ACP tool updates are top-level patches. Keep the detached fields that can
 * make a later id-only permission request understandable to the user. */
function mergeToolCallSnapshot(
  previous: acp.ToolCallUpdate | undefined,
  patch: acp.ToolCallUpdate,
): acp.ToolCallUpdate {
  const next: acp.ToolCallUpdate = { ...(previous ?? {}), toolCallId: patch.toolCallId }
  if (patch.kind !== undefined) next.kind = patch.kind
  if (patch.status !== undefined) next.status = patch.status
  // ACP explicitly treats `name: null` as unchanged. A created tool call has
  // a required title, so retain that useful title across nullable updates too.
  if (patch.title !== undefined && patch.title !== null) next.title = patch.title
  if (patch.name !== undefined && patch.name !== null) next.name = patch.name
  if (patch.content !== undefined) next.content = patch.content
  if (patch.locations !== undefined) next.locations = patch.locations
  if (patch.rawInput !== undefined) next.rawInput = patch.rawInput
  if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput
  if (patch._meta !== undefined) next._meta = patch._meta
  return structuredClone(next)
}

/**
 * Some ACP agents stream a complete JSON argument object through tool content
 * immediately before requesting permission, but omit `rawInput` from the
 * request itself.  Recover only a complete, bounded execute-command object;
 * partial JSON and arbitrary prose remain unusable rather than being guessed.
 */
function executeInputFromContent(content: unknown): Record<string, unknown> | undefined {
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const block = value as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'content') visit(block.content)
  }
  visit(content)
  const serialized = parts.join('').trim()
  if (serialized === '' || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(serialized) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const input = parsed as Record<string, unknown>
  const command = input.command ?? input.cmd
  const argv = input.argv
  if (
    !(typeof command === 'string' && command.trim() !== '')
    && !(Array.isArray(argv) && argv.length > 0 && argv.every(item => typeof item === 'string'))
  ) return undefined
  return structuredClone(input)
}

function permissionToolCall(
  prior: acp.ToolCallUpdate | undefined,
  request: acp.ToolCallUpdate,
): acp.ToolCallUpdate {
  const toolCall = prior === undefined ? structuredClone(request) : mergeToolCallSnapshot(prior, request)
  if (toolCall.kind === 'execute' && toolCall.rawInput === undefined) {
    // Kimi replaces the streamed JSON argument content with human-readable
    // approval prose on the request itself. Prefer the request when it still
    // contains structured input, then fall back to the preceding snapshot.
    const recovered = executeInputFromContent(toolCall.content) ?? executeInputFromContent(prior?.content)
    if (recovered !== undefined) toolCall.rawInput = recovered
  }
  return toolCall
}

/** Kimi namespaces permission ids as `<turn>:<tool-id>` while its preceding
 * standard tool updates use the unprefixed id.  Accept that one documented
 * numeric namespace form only, and only when the candidate is unambiguous and
 * kind-compatible; all other opaque ids remain exact-match only. */
function permissionPriorSnapshot(
  snapshots: ReadonlyMap<string, acp.ToolCallUpdate> | undefined,
  request: acp.ToolCallUpdate,
): acp.ToolCallUpdate | undefined {
  const exact = snapshots?.get(request.toolCallId)
  if (exact !== undefined) return exact
  const match = /^(\d+):(.+)$/.exec(request.toolCallId)
  if (match?.[2] !== undefined) {
    const candidate = snapshots?.get(match[2])
    if (candidate !== undefined) {
      if (request.kind !== undefined && candidate.kind !== undefined && request.kind !== candidate.kind) return undefined
      return candidate
    }
  }
  // A sole candidate can belong to an earlier operation, including a completed
  // one. Without a matching identity, keep the request's own details only.
  return undefined
}

const ACP_PERMISSION_INPUT_GRACE_MS = 1_500

async function completePermissionToolCall(
  snapshots: ReadonlyMap<string, acp.ToolCallUpdate> | undefined,
  request: acp.ToolCallUpdate,
  signal: AbortSignal | undefined,
): Promise<acp.ToolCallUpdate> {
  const deadline = Date.now() + ACP_PERMISSION_INPUT_GRACE_MS
  let toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  while (toolCall.kind === 'execute' && toolCall.rawInput === undefined && Date.now() < deadline && !isAborted(signal)) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  }
  return toolCall
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
  if (signal === undefined) return await pending
  let listener: (() => void) | undefined
  const aborted = new Promise<T>(resolve => {
    listener = () => resolve(onAbort())
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([pending, aborted]) } finally { if (listener !== undefined) signal.removeEventListener('abort', listener) }
}

/** A bounded, detached ACP session configuration snapshot. */
/** One reusable ACP connection/session, lazily started on the first prompt. */
export class AcpSessionRuntime {
  private connection: AcpClientConnection | undefined
  private mcpLease: AcpMcpLease | undefined
  private mcpKey: unknown
  private sessionId: string | undefined
  private starting: Promise<void> | undefined
  private launch: AcpRuntimeLaunch | undefined
  private replayHandler: ((notification: AcpSessionNotification) => void) | undefined
  private restoringSessionId: string | undefined
  private connectionAbort: AbortController | undefined
  private promptAbort: AbortController | undefined
  private promptSignal: AbortSignal | undefined
  private configSnapshot: acp.SessionConfigOption[] | undefined
  private currentMode: string | undefined
  private modeSnapshot: acp.SessionModeState | undefined
  private usageSnapshot: AcpRuntimeContextUsage | undefined
  private configWrite: Promise<void> = Promise.resolve()
  /** Claim the complete prompt lifecycle, including lazy session setup. This is
   * distinct from promptActive, which gates Agent callbacks only after the
   * session/prompt request has actually been dispatched. */
  private promptClaimed = false
  private promptActive = false
  /** One map per active prompt. Tool call ids are only meaningful inside this
   * lifetime for permission enrichment and must never leak into another turn. */
  private promptToolSnapshots: Map<string, acp.ToolCallUpdate> | undefined
  private readonly cancelGraceMs: number

  constructor(private readonly options: AcpSessionRuntimeOptions) {
    this.cancelGraceMs = options.cancelGraceMs ?? ACP_CANCEL_SETTLE_GRACE_MS
  }

  get acpSessionId(): string | undefined { return this.sessionId }
  get agentCapabilities(): acp.AgentCapabilities | undefined { return this.connection?.agentCapabilities }
  get agentInfo(): acp.Implementation | null | undefined { return this.connection?.agentInfo }
  get protocolVersion(): number | undefined { return this.connection?.protocolVersion }
  get launchInfo(): AcpRuntimeLaunch | undefined { return this.launch }
  /** Latest detached options advertised by this ACP session. */
  get configOptions(): readonly acp.SessionConfigOption[] | undefined { return this.configSnapshot }
  get currentModeId(): string | undefined { return this.currentMode }
  /** Complete detached legacy mode state advertised by this ACP session. */
  get modes(): acp.SessionModeState | undefined { return this.modeSnapshot }
  /** ACP context occupancy/cumulative cost; intentionally not DSH TokenUsage. */
  get contextUsage(): AcpRuntimeContextUsage | undefined { return this.usageSnapshot }
  get isBusy(): boolean { return this.promptClaimed }
  private pendingQuestions = 0
  /** Qwen-initiated turns, oldest first; the last one may still be live. */
  private agentTurns: AgentTurn[] = []
  private readonly agentTurnWaiters = new Set<() => void>()
  /** A host prompt() is waiting to adopt an Agent-initiated turn. */
  private awaitingAgentTurn = false
  /** `session/prompt` RPC is on the wire (updates arrive through its listener). */
  private wirePromptActive = false
  private qwenTasks: QwenBackgroundTasks | undefined
  get canSteer(): boolean { return this.connection?.supportsSteering === true && this.pendingQuestions === 0 }

  async steer(content: acp.ContentBlock[]): Promise<'injected' | 'promptRequired'> {
    if (!this.canSteer || !this.promptActive || this.sessionId === undefined) return 'promptRequired'
    return await this.connection!.steer(this.sessionId, content)
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.initialize(signal)
    if (this.sessionId !== undefined) return
    this.starting ??= this.createSession(signal)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /** Initialize and negotiate capabilities without creating session/new. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.connection !== undefined && (this.connection.isClosed || this.mcpLease?.signal.aborted === true || this.mcpKey !== this.options.mcpKey?.())) await this.close()
    if (this.connection !== undefined) return
    this.starting ??= this.createConnection(signal)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /**
   * Restore an already-bound ACP session. `session/resume` is preferred because
   * it does not replay presentation history. `session/load` is an explicit
   * staging path: notifications are forwarded to the caller but never written
   * to DSH history by this runtime.
   */
  async restore(
    binding: AcpRuntimeBindingRef,
    signal?: AbortSignal,
    onReplay?: (notification: AcpSessionNotification) => void,
  ): Promise<'reused' | 'resumed' | 'loaded'> {
    // A closed transport cannot own a reusable in-memory session, even if the
    // remote session id is still cached. Clear local state before deciding
    // whether this binding can be reused; the caller's durable recovery guard
    // remains responsible for authorizing a resume after an unknown outcome.
    if (this.connection?.isClosed === true) await this.close()
    if (this.sessionId !== undefined) {
      if (this.sessionId !== binding.agentSessionId) throw new Error('ACP binding session id does not match the active runtime')
      return 'reused'
    }
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const caps = connection.agentCapabilities
    const mcpServers = this.mcpLease?.servers ?? []
    const rpcOptions = signal === undefined ? {} : { signal }
    this.replayHandler = onReplay
    this.restoringSessionId = binding.agentSessionId
    try {
      if (caps?.sessionCapabilities?.resume != null) {
        const response = await connection.resumeSession(binding.agentSessionId, { cwd: this.options.cwd, mcpServers }, rpcOptions)
        this.applySessionSnapshot(response)
        this.sessionId = binding.agentSessionId
        return 'resumed'
      }
      if (caps?.loadSession !== true) {
        throw new Error('ACP agent does not advertise session/resume or session/load')
      }
      const response = await connection.loadSession(binding.agentSessionId, { cwd: this.options.cwd, mcpServers }, rpcOptions)
      this.applySessionSnapshot(response)
      this.sessionId = binding.agentSessionId
      return 'loaded'
    } finally {
      this.replayHandler = undefined
      this.restoringSessionId = undefined
    }
  }

  /**
   * Create a child ACP session from an already-bound parent. This is kept
   * separate from start(): a successful fork owns the returned child id and
   * must never first create an unrelated session/new.
   */
  async fork(parentSessionId: string, signal?: AbortSignal, expected?: { readonly agent?: { readonly name?: string; readonly version?: string }; readonly protocolVersion?: number }, beforeDispatch?: () => Promise<void>): Promise<acp.ForkSessionResponse> {
    if (this.sessionId !== undefined) throw new Error('ACP runtime already owns a session')
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const mcpServers = this.mcpLease?.servers ?? []
    try {
      if (!supportsFork(connection.agentCapabilities)) throw new Error('ACP_FORK_UNSUPPORTED')
      if (expected?.protocolVersion !== undefined && connection.protocolVersion !== expected.protocolVersion) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.name !== undefined && connection.agentInfo?.name !== expected.agent.name) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.version !== undefined && connection.agentInfo?.version !== expected.agent.version) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      try {
        await beforeDispatch?.()
      } catch (error) {
        throw new Error(`ACP_FORK_INTENT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
      }
      const response = await connection.forkSession(parentSessionId, { cwd: this.options.cwd, mcpServers }, signal === undefined ? {} : { signal })
      if (typeof response.sessionId !== 'string' || response.sessionId.length === 0 || response.sessionId === parentSessionId) {
        throw new Error('ACP_FORK_INVALID_RESPONSE')
      }
      this.applySessionSnapshot(response)
      this.sessionId = response.sessionId
      return response
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: AcpSessionNotification) => void,
    signal?: AbortSignal,
    onTeamReport?: () => void,
    promptOptions: AcpPromptOptions = {},
  ): Promise<acp.PromptResponse> {
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    this.promptClaimed = true
    const promptAbort = new AbortController()
    this.promptAbort = promptAbort
    const setupSignal = signal === undefined ? promptAbort.signal : AbortSignal.any([signal, promptAbort.signal])
    try {
      // A turn cancelled before dispatch has no remote outcome to reconcile.
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      // Claim the prompt first, preventing further UI writes, then finish any
      // already admitted setting changes before sending this turn.
      await this.configWrite
      if (setupSignal.aborted) return { stopReason: 'cancelled' }
      await this.start(setupSignal)
      const connection = this.connection
      const sessionId = this.sessionId
      if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      if (promptOptions.adoptAgentTurn === true) {
        const turn = await this.nextAgentTurn(setupSignal)
        if (turn !== undefined) return await this.runAgentTurn(connection, sessionId, turn, onUpdate, signal, promptAbort, onTeamReport)
        if (isAborted(signal)) return { stopReason: 'cancelled' }
      }
      const promptToolSnapshots = new Map<string, acp.ToolCallUpdate>()
      this.promptToolSnapshots?.clear()
      this.promptToolSnapshots = promptToolSnapshots
      this.promptActive = true
      this.promptAbort = promptAbort
      this.promptSignal = signal
      this.mcpLease?.beginPrompt(this.permissionSignal() ?? promptAbort.signal, onTeamReport)
      // Do not pass the turn signal into the RPC budget layer: abandoning an
      // in-flight JSON-RPC request poisons the connection. ACP cancellation is a
      // protocol notification followed by a bounded wait for this same prompt.
      const instructions = this.mcpLease?.instructions
      this.wirePromptActive = true
      const prompting = connection.prompt(sessionId, instructions === undefined ? content : [{ type: 'text', text: instructions }, ...content], notification => {
        // Qwen's discrete "background task completed" line is task state, not
        // part of the assistant answer; it would otherwise run into the reply.
        if (qwenTaskCompletion(notification) !== undefined) return
        const update = notification.update
        // Permission snapshots retain the original wire identity; only the presentation callback is normalized.
        const presented = notification.sessionId === sessionId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
          ? this.mcpLease?.presentTool?.(update) : undefined
        onUpdate(presented === undefined ? notification : { ...notification, update: { ...update, ...presented } as typeof update })
      })
      let settled = false
      void prompting.then(
        () => { settled = true },
        () => { settled = true },
      )
      const onAbort = (): void => {
        if (settled) return
        void connection.cancel(sessionId).catch(() => undefined)
        void waitWithin(prompting, this.cancelGraceMs).then(
          (response) => {
            if (response !== undefined || settled || this.connection !== connection || connection.isClosed) return
            // The remote outcome is now unknown. Closing the connection rejects
            // the still-pending prompt, allowing the adapter's existing recovery
            // guard to take over instead of hanging the DSH turn indefinitely.
            void connection.close().catch(() => undefined)
          },
          () => { /* prompt failed inside the grace period; no escalation needed */ },
        )
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (isAborted(signal)) onAbort()
      try {
        const response = await prompting
        void this.ensureQwenTasks()?.refresh()
        return response
      } finally {
        this.wirePromptActive = false
        signal?.removeEventListener('abort', onAbort)
        // Permission requests are scoped to this prompt, not merely to the
        // process connection. Natural completion must cancel an unresolved host
        // question just as Stop does, before another turn can begin.
        promptAbort.abort(new Error('ACP prompt lifetime ended'))
        this.mcpLease?.endPrompt()
        if (this.promptAbort === promptAbort) {
          promptToolSnapshots.clear()
          if (this.promptToolSnapshots === promptToolSnapshots) this.promptToolSnapshots = undefined
          this.promptAbort = undefined
          this.promptSignal = undefined
          this.promptActive = false
        }
      }
    } finally {
      promptAbort.abort(new Error('ACP prompt lifetime ended'))
      if (this.promptAbort === promptAbort) this.promptAbort = undefined
      this.promptClaimed = false
    }
  }

  /** Set one ACP option for this runtime's session; writes are serialized and never cross sessions. */
  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const connection = this.connection
    const sessionId = this.sessionId
    if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      if (connection !== this.connection || sessionId !== this.sessionId) throw new Error('ACP configuration connection changed')
      const response = await connection.setConfigOption(sessionId, configId, value, signal === undefined ? {} : { signal })
      if (connection !== this.connection || sessionId !== this.sessionId) throw new Error('ACP configuration connection changed')
      this.configSnapshot = acpConfigOptionsSnapshot(response.configOptions)
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  /** Set a legacy ACP mode for this runtime's session. */
  async setMode(modeId: string, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const connection = this.connection
    const sessionId = this.sessionId
    if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      if (connection !== this.connection || sessionId !== this.sessionId) throw new Error('ACP configuration connection changed')
      await connection.setMode(sessionId, modeId, signal === undefined ? {} : { signal })
      if (connection !== this.connection || sessionId !== this.sessionId) throw new Error('ACP configuration connection changed')
      this.currentMode = modeId
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  async close(): Promise<void> {
    this.promptAbort?.abort(new Error('ACP session runtime closed'))
    for (const turn of this.agentTurns) turn.end('cancelled')
    this.agentTurns = []
    this.notifyAgentTurnWaiters()
    this.qwenTasks?.close()
    this.qwenTasks = undefined
    this.promptToolSnapshots?.clear()
    this.promptToolSnapshots = undefined
    this.connectionAbort?.abort()
    this.connectionAbort = undefined
    const closed = await Promise.allSettled([this.mcpLease?.close(), this.connection?.close()])
    this.mcpLease = undefined
    this.connection = undefined
    this.sessionId = undefined
    this.launch = undefined
    this.configSnapshot = undefined
    this.currentMode = undefined
    this.modeSnapshot = undefined
    this.usageSnapshot = undefined
    const errors = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length > 0) throw new AggregateError(errors.map(result => result.reason), 'ACP runtime cleanup failed')
  }

  private async createSession(signal?: AbortSignal): Promise<void> {
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    try {
      const session = await connection.newSession({ cwd: this.options.cwd, mcpServers: this.mcpLease?.servers ?? [] }, signal === undefined ? {} : { signal })
      this.applySessionSnapshot(session)
      this.sessionId = session.sessionId
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  private async createConnection(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    // Teardown can arrive while prepareLaunch/initialize is still pending.
    // Own its cancellation before awaiting either, so a disposed session cannot
    // publish a newly initialized child after close() has returned.
    const connectionAbort = new AbortController()
    this.connectionAbort = connectionAbort
    const setupSignal = signal === undefined ? connectionAbort.signal : AbortSignal.any([signal, connectionAbort.signal])
    const launch = await this.options.prepareLaunch(this.options.config, this.options.cwd)
    if (setupSignal.aborted) {
      await launch.mcpLease?.close().catch(() => undefined)
      setupSignal.throwIfAborted()
    }
    this.launch = launch
    this.mcpLease = launch.mcpLease
    const spec: AcpConnectionSpec = {
      argv: [...launch.argv],
      cwd: this.options.cwd,
      env: launch.env,
      spawnPlan: launch.spawnPlan,
      subprocess: this.options.subprocess,
    }
    const fileSystemHandlers = this.options.createFileSystemHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const terminalHandlers = this.options.createTerminalHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const connection = new AcpClientConnection(spec, {
      ...(this.options.enableClaudeDraftSubagents === true ? { enableClaudeDraftSubagents: true } : {}),
      ...(this.options.onCapabilityDegraded === undefined ? {} : { onCapabilityDegraded: this.options.onCapabilityDegraded }),
      ...(fileSystemHandlers === undefined ? {} : { fileSystemHandlers }),
      ...(terminalHandlers === undefined ? {} : { terminalHandlers }),
      ...(this.options.onPermissionRequest === undefined ? {} : {
        onPermissionRequest: async (params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
          this.pendingQuestions += 1
          try { return await this.handlePermissionRequest(params) } finally { this.pendingQuestions -= 1 }
        },
      }),
      ...(this.options.onElicitationRequest === undefined ? {} : {
        onElicitationRequest: async (params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> => {
          const signal = this.permissionSignal()
          if (!this.promptActive || isAborted(signal)) return { action: 'cancel' }
          const scope = params as { sessionId?: unknown; toolCallId?: unknown }
          const toolCall = scope.sessionId !== this.sessionId || typeof scope.toolCallId !== 'string'
            ? undefined : this.promptToolSnapshots?.get(scope.toolCallId)
          this.pendingQuestions += 1
          try {
            const lease = this.mcpLease
            const automaticPromise = Promise.resolve(lease?.elicitation?.(params, toolCall))
            let automatic: acp.CreateElicitationResponse | undefined
            if (signal === undefined) automatic = await automaticPromise
            else {
              const abortToken = Symbol('abort')
              let onAbort: (() => void) | undefined
              const aborted = new Promise<typeof abortToken>(resolve => {
                onAbort = () => resolve(abortToken)
                if (isAborted(signal)) onAbort()
                else signal.addEventListener('abort', onAbort, { once: true })
              })
              try {
                const result = await Promise.race([automaticPromise, aborted])
                if (result === abortToken) return { action: 'cancel' }
                automatic = result
              } finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort) }
            }
            if (isAborted(signal) || lease !== this.mcpLease || lease?.signal.aborted) return { action: 'cancel' }
            if (automatic !== undefined) return automatic
            const hostToolName = this.mcpLease?.elicitationToolName?.(params, toolCall)
            return await this.options.onElicitationRequest!(params, signal, hostToolName,
              hostToolName === undefined ? undefined : toolCall)
          }
          finally { this.pendingQuestions -= 1 }
        },
      }),
      ...(this.options.qwenTaskJobs === undefined ? {} : {
        onQwenTurnStart: (params: QwenTurnStartParams) => this.startAgentTurn(params),
        onQwenTurnEnd: (params: QwenTurnEndParams) => { this.endAgentTurn(params) },
      }),
      onSessionUpdate: (notification) => {
        if (connectionAbort.signal.aborted) return
        this.routeAgentTurnUpdate(notification)
        this.applyUpdate(notification)
        this.replayHandler?.(notification)
        this.options.onSessionUpdate?.(notification)
      },
    })
    try {
      await connection.initialize({ signal: setupSignal })
      this.mcpKey = this.options.mcpKey?.()
      this.mcpLease ??= await this.options.createMcpLease?.(connection.agentCapabilities)
      setupSignal.throwIfAborted()
      this.connection = connection
      this.connectionAbort = connectionAbort
    } catch (error) {
      await connection.close().catch(() => undefined)
      await this.mcpLease?.close().catch(() => undefined)
      this.mcpLease = undefined
      this.launch = undefined
      throw error
    }
  }

  private applySessionSnapshot(snapshot: { readonly configOptions?: readonly acp.SessionConfigOption[] | null; readonly modes?: acp.SessionModeState | null }): void {
    if (snapshot.configOptions !== undefined && snapshot.configOptions !== null) this.configSnapshot = acpConfigOptionsSnapshot(snapshot.configOptions)
    if (snapshot.modes?.currentModeId !== undefined) {
      this.currentMode = snapshot.modes.currentModeId
      this.modeSnapshot = structuredClone(snapshot.modes)
    }
  }

  private applyUpdate(notification: AcpSessionNotification): void {
    // Claude's negotiated child-session updates share this connection. They
    // are forwarded to the external-subagent projector, but never own the
    // parent's model, mode, usage or permission snapshots.
    if (notification.sessionId !== (this.sessionId ?? this.restoringSessionId)) return
    const update = notification.update
    if (
      (this.promptActive || this.liveAgentTurn() !== undefined)
      && notification.sessionId === this.sessionId
      && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    ) {
      // Keep permission enrichment prompt- and session-scoped. Kimi streams
      // tool arguments before requesting permission, so the map is cleared at
      // every turn boundary and can never authorize data from another turn.
      const snapshots = this.promptToolSnapshots
      if (snapshots !== undefined) snapshots.set(update.toolCallId, mergeToolCallSnapshot(snapshots.get(update.toolCallId), update))
    }
    if (update.sessionUpdate === 'config_option_update') this.configSnapshot = acpConfigOptionsSnapshot(update.configOptions)
    if (update.sessionUpdate === 'current_mode_update') {
      this.currentMode = update.currentModeId
      if (this.modeSnapshot !== undefined) this.modeSnapshot = { ...this.modeSnapshot, currentModeId: update.currentModeId }
    }
    if (update.sessionUpdate === 'usage_update') {
      const cost = update.cost
      this.usageSnapshot = {
        used: update.used,
        size: update.size,
        ...(cost === undefined ? {} : { cost: cost === null ? null : { amount: cost.amount, currency: cost.currency } }),
      }
    }
  }

  private ensureQwenTasks(): QwenBackgroundTasks | undefined {
    if (this.qwenTasks !== undefined) return this.qwenTasks
    const startJob = this.options.qwenTaskJobs
    const connection = this.connection
    const sessionId = this.sessionId
    if (startJob === undefined || connection === undefined || sessionId === undefined || connection.agentInfo?.name !== QWEN_AGENT_NAME) return undefined
    this.qwenTasks = new QwenBackgroundTasks({
      startJob,
      listTasks: async () => {
        if (connection !== this.connection || connection.isClosed) return undefined
        return qwenTaskSnapshots(await connection.extRequest('qwen/status/session/tasks', { sessionId }))
      },
      cancelTask: async (taskId, taskKind) => {
        if (connection !== this.connection || connection.isClosed) return
        await connection.extRequest('qwen/control/session/task/cancel', { sessionId, taskId, taskKind })
      },
    })
    return this.qwenTasks
  }

  private notifyAgentTurnWaiters(): void {
    for (const wake of [...this.agentTurnWaiters]) wake()
  }

  /** Resolve on the next Agent-turn state change or after `ms`. */
  private agentTurnChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.agentTurnWaiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      timer = setTimeout(wake, Math.max(1, ms))
      this.agentTurnWaiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  private liveAgentTurn(): AgentTurn | undefined {
    const last = this.agentTurns.at(-1)
    return last !== undefined && last.ended === undefined ? last : undefined
  }

  private startAgentTurn(params: QwenTurnStartParams): QwenTurnStartResult {
    const notFound = (): never => { throw RequestError.methodNotFound('_qwencode/start_turn') }
    if (params.sessionId !== this.sessionId) return { accepted: false }
    // Only background notification turns are adopted; others keep Qwen's own fallback.
    if (params.source !== 'background_notification') return notFound()
    // A host prompt owns the session; Qwen retries the notification after it.
    if (this.promptClaimed && !this.awaitingAgentTurn) return { accepted: false }
    if (this.liveAgentTurn() !== undefined) return { accepted: false }
    const tasks = this.ensureQwenTasks()
    if (tasks === undefined) return notFound()
    let resolveEnded!: (reason: string) => void
    const endedPromise = new Promise<string>(resolve => { resolveEnded = resolve })
    const turn: AgentTurn = {
      turnId: params.turnId, buffer: [], listener: undefined, ended: undefined, endedPromise,
      end: (reason) => {
        if (turn.ended !== undefined) return
        turn.ended = reason
        resolveEnded(reason)
      },
    }
    // A host call already waiting adopts it directly; otherwise the task's
    // native job settles unawaited and DSH wakes the idle agent.
    if (!this.awaitingAgentTurn && !tasks.wake(params)) return notFound()
    this.agentTurns.push(turn)
    this.promptToolSnapshots ??= new Map()
    this.connection?.setAgentTurnActive(params.sessionId, true)
    this.notifyAgentTurnWaiters()
    return { accepted: true }
  }

  private endAgentTurn(params: QwenTurnEndParams): void {
    if (params.sessionId !== this.sessionId) return
    const turn = this.agentTurns.find(candidate => candidate.turnId === params.turnId)
    if (turn === undefined) return
    turn.end(params.reason ?? 'end_turn')
    if (this.liveAgentTurn() === undefined) this.connection?.setAgentTurnActive(params.sessionId, false)
    if (turn.listener === undefined) {
      // Not adopted yet: keep a bounded record for the woken host turn only.
      const stale = setTimeout(() => {
        if (turn.listener === undefined) this.agentTurns = this.agentTurns.filter(candidate => candidate !== turn)
      }, 120_000)
      stale.unref?.()
    }
    this.notifyAgentTurnWaiters()
  }

  private routeAgentTurnUpdate(notification: AcpSessionNotification): void {
    if (notification.sessionId !== this.sessionId) return
    const completion = qwenTaskCompletion(notification)
    if (completion !== undefined) {
      this.ensureQwenTasks()?.complete(completion, this.wirePromptActive)
      return
    }
    if (this.wirePromptActive) return
    const turn = this.liveAgentTurn()
    if (turn === undefined) return
    if (turn.listener !== undefined) turn.listener(notification)
    else if (turn.buffer.length < AGENT_TURN_BUFFER_MAX) turn.buffer.push(notification)
  }

  private async waitForAdoption(): Promise<void> {
    const deadline = Date.now() + AGENT_TURN_ADOPTION_MAX_MS
    while (!this.promptActive && this.liveAgentTurn() !== undefined && Date.now() < deadline && this.connection?.isClosed !== true) {
      await this.agentTurnChange(Math.min(1_000, deadline - Date.now()))
    }
  }

  /** Oldest unadopted Agent turn, waiting briefly for Qwen's announcement. */
  private async nextAgentTurn(signal: AbortSignal): Promise<AgentTurn | undefined> {
    const pick = (): AgentTurn | undefined => this.agentTurns.find(turn => turn.listener === undefined)
    const deadline = Date.now() + (this.options.agentTurnWaitMs ?? 5_000)
    this.awaitingAgentTurn = true
    try {
      let turn = pick()
      while (turn === undefined && !signal.aborted && Date.now() < deadline && this.connection?.isClosed !== true) {
        await this.agentTurnChange(deadline - Date.now(), signal)
        turn = pick()
      }
      return turn
    } finally { this.awaitingAgentTurn = false }
  }

  /** Present an Agent-initiated turn as this host prompt until `_qwencode/end_turn`. */
  private async runAgentTurn(
    connection: AcpClientConnection,
    sessionId: string,
    turn: AgentTurn,
    onUpdate: (notification: AcpSessionNotification) => void,
    signal: AbortSignal | undefined,
    promptAbort: AbortController,
    onTeamReport: (() => void) | undefined,
  ): Promise<acp.PromptResponse> {
    const snapshots = this.promptToolSnapshots ?? new Map<string, acp.ToolCallUpdate>()
    this.promptToolSnapshots = snapshots
    this.promptActive = true
    this.promptAbort = promptAbort
    this.promptSignal = signal
    this.mcpLease?.beginPrompt(this.permissionSignal() ?? promptAbort.signal, onTeamReport)
    const deliver = (notification: AcpSessionNotification): void => {
      const update = notification.update
      const presented = notification.sessionId === sessionId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
        ? this.mcpLease?.presentTool?.(update) : undefined
      onUpdate(presented === undefined ? notification : { ...notification, update: { ...update, ...presented } as typeof update })
    }
    for (const notification of turn.buffer.splice(0)) deliver(notification)
    turn.listener = deliver
    this.notifyAgentTurnWaiters()
    const onAbort = (): void => {
      if (turn.ended !== undefined) return
      // session/cancel aborts Qwen's notification turn (and pauses further
      // automatic turns until the next user prompt); the tasks keep running.
      void connection.cancel(sessionId).catch(() => undefined)
      void waitWithin(turn.endedPromise, this.cancelGraceMs).then(reason => { if (reason === undefined) turn.end('cancelled') })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (isAborted(signal)) onAbort()
    try {
      const reason = await Promise.race([turn.endedPromise, connection.failed])
      return { stopReason: (ACP_STOP_REASONS.has(reason) ? reason : 'end_turn') as acp.StopReason }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      turn.listener = () => undefined
      this.agentTurns = this.agentTurns.filter(candidate => candidate !== turn)
      if (this.liveAgentTurn() === undefined) connection.setAgentTurnActive(sessionId, false)
      promptAbort.abort(new Error('ACP prompt lifetime ended'))
      this.mcpLease?.endPrompt()
      snapshots.clear()
      if (this.promptToolSnapshots === snapshots) this.promptToolSnapshots = undefined
      this.promptSignal = undefined
      this.promptActive = false
      void this.ensureQwenTasks()?.refresh()
    }
  }

  private permissionSignal(): AbortSignal | undefined {
    const connectionSignal = this.connectionAbort?.signal
    const promptLifetimeSignal = this.promptAbort?.signal
    const promptSignal = this.promptSignal
    const signals = [connectionSignal, promptLifetimeSignal, promptSignal].filter((signal): signal is AbortSignal => signal !== undefined)
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    return AbortSignal.any(signals)
  }

  private async handlePermissionRequest(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const cancelled = (): acp.RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } })
    // A Qwen-initiated turn may ask before the woken host turn has adopted it.
    if (!this.promptActive && params.sessionId === this.sessionId && this.liveAgentTurn() !== undefined) await this.waitForAdoption()
    if (!this.promptActive || this.sessionId === undefined || params.sessionId !== this.sessionId) return cancelled()
    const handler = this.options.onPermissionRequest
    if (handler === undefined) return cancelled()
    const signal = this.permissionSignal()
    if (isAborted(signal)) return cancelled()
    if (isQwenUserQuestion(params)) {
      // A question is not an approval: never run it through the tool approval
      // policy (Auto must not "approve" it with an empty answer).
      const ask = this.options.onQwenQuestion
      if (ask === undefined) return cancelled()
      return await raceAbort(ask(params, signal), signal, cancelled)
    }
    const request = {
      ...params,
      toolCall: await completePermissionToolCall(this.promptToolSnapshots, params.toolCall, signal),
    }
    const lease = this.mcpLease
    const inspectPromise = Promise.resolve(lease?.inspectPermission?.(request))
    let inspected: Awaited<typeof inspectPromise>
    if (signal === undefined) inspected = await inspectPromise
    else {
      const abortToken = Symbol('permission-abort')
      let onAbort: (() => void) | undefined
      const aborted = new Promise<typeof abortToken>(resolve => {
        onAbort = () => resolve(abortToken)
        if (isAborted(signal)) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const result = await Promise.race([inspectPromise, aborted])
        if (result === abortToken) return cancelled()
        inspected = result
      } finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort) }
    }
    if (this.options.onPermissionCheck !== undefined) {
      // Audit stores only the bounded decision facts, never capability names or addresses.
      try { await this.options.onPermissionCheck(inspected ?? { reason: 'bridge-unavailable' }, request) }
      catch { return cancelled() }
    }
    if (isAborted(signal) || lease !== this.mcpLease || lease?.signal.aborted
      || (inspected?.reason === 'auto-approved' && lease?.validatePermissionDecision?.(request) === false)) return cancelled()
    // Use the very policy resolution that was audited above. Re-reading here
    // could turn an audited Ask into an automatic approval (or the reverse).
    const bridgeDecision = inspected === undefined ? await lease?.permission(request) : inspected.response
    if (bridgeDecision !== undefined) return bridgeDecision
    // Resolve bridge decisions against the original wire identity first; normalize
    // only the request shown by the native approval surface.
    const pending = handler({ ...request, toolCall: this.mcpLease?.presentTool?.(request.toolCall) ?? request.toolCall }, signal)
    if (signal === undefined) return await pending
    let onAbort: (() => void) | undefined
    const aborted = new Promise<acp.RequestPermissionResponse>((resolve) => {
      onAbort = () => { resolve(cancelled()) }
      if (isAborted(signal)) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // The native question service receives the same signal, but the ACP RPC
      // must still settle if a host implementation fails to honor it. The race
      // also observes a late handler rejection, avoiding an unhandled promise.
      return await Promise.race([pending, aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}
