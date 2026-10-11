# DSH alpha.2 源码核对与优化

本次优化的目标是：不增加用户的配置、操作或迁移负担，保留现有功能，优先采用能够保持这些条件的官方新特性和逻辑。UI/UX 同时核对原生入口、交互、状态反馈和主题设置，避免增加相互冲突的第二套机制。工作在 `0.2.1-alpha` 分支进行，不发布、不创建版本标签，也不合并 main；Antigravity 默认配置继续暂缓。

## 范围与方法

2026-10-09 通过上游实时分支及标签查询，并于 10 月 10 日再次复核，确认 `master` 仍为 DSH `0.2.1-alpha.2`，提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。插件审查起点为 `365952a685b28315b326568a946354a1379d9498`。精确依赖与上一轮兼容结果见 [alpha 兼容记录](dsh-0.2.1-alpha.md)。

每个业务领域都沿生产入口、官方提供方、消费接口和可观察结果核对源码。先判断官方能力是否覆盖现有行为，再确认能删除的维护工作、保留的适配和回归风险；仅移动复杂度、引入新配置或减少用户能力的替换不作为优化。下表是源码核对范围，不代表所有平台和真实 Agent 都重新验收。

## 业务全景

| 业务领域                         | 插件实现 / 官方实现                                                                                                                          | 采用与保留判断                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装、配置、Agent 目录           | `src/client/data/catalog.ts`、`src/host/composition/config.ts` / `packages/boot/plugin-manager`、官方配置编辑器                              | 继续使用可安装插件配置层、原生配置编辑和构建时 Registry 快照；目录元数据不决定运行权限。官方 Codex/Claude bundle 是可选后台委派，不强制安装或迁移已有 ACP 连接                    |
| ACP 协议与能力协商               | `src/protocol/v1/connection.ts` / `packages/subagent/subagent-acp/src/run.ts`                                                                | 已采用官方 ACP SDK；保留图片、文件、终端、认证和会话能力协商。官方 ACP 子任务只执行一次，不能替代交互式连接                                                                       |
| 进程、期限、取消                 | `src/runtime/process` / `packages/subprocess`、`packages/util/timeout`                                                                       | 已消费宿主 subprocess 与 timeout；保留 ACP 取消收敛、期限分类与连接关闭。任务完成、进程退出和资源释放分别处理                                                                     |
| 输入、Queue、Steer               | `src/domain/session/current-step-admission.ts`、`src/host/composition/stream-handoff.ts` / `packages/core/agent`、`packages/core/agent-loop` | 沿用原生 inbox、pre-step 和已提交输入；只转发当前准入输入，不以完整历史代替当前请求，不自行创建第二个 AgentLoop                                                                   |
| 会话连续性、恢复、持久化         | `src/runtime/session`、`src/persistence/sidecar.ts` / `packages/session`、`packages/session-projection`                                      | 原生投影拥有执行事实的缓存与恢复；Sidecar 保留 binding、dispatch 与诊断事务。确认远端完成后的本地补存与远端结果未知分别处理，不能改成用户手动重试                                 |
| 共享 AGENTS 与运行时 skills      | `src/domain/session/prompt-content.ts`、`model-context-snapshots.ts` / `packages/context/agent-instructions`、`packages/skill`               | 读取宿主已组装的有效指令和当前工具路由，兼容共享 agents 根及可变工作目录；不复制到 Agent 私有目录、不增加同步器。空白重绑定需要恢复当前有效指令，见下方改动                       |
| DSH 工具、MCP、PTC               | `src/host/teams/bridge.ts`、`tool-execution-scheduler.ts` / `packages/core/tools`、`packages/ptc-runtime`                                    | 继续调用公开 `tools.execute`，遵循每次请求的 native 或 PTC 呈现、可见工具交集和撤销规则；官方内部 `ToolRuntimeScheduler` 不能作为插件公开接口依赖                                 |
| 审批、权限、问答                 | `src/domain/policy`、`src/client/ui/acp-permission-question.ts` / `packages/interaction`、原生审批与问题组件                                 | 普通请求使用原生组件；固定权限选项保留明确选择与提交，不引入自由回答或默认批准。Agent 自有权限与 DSH 工具策略保持各自归属                                                         |
| 文件与终端客户端能力             | `src/runtime/client-capabilities` / `packages/fs`、`packages/subprocess`                                                                     | 宿主服务能复用的继续复用。文件字节、最终符号链接、并发哈希保护和原子创建不能由会规范化文本的写入接口等价替代；错误分类改用结构化标识                                              |
| Teams 通信与管理                 | `src/host/teams`、`AcpTeamManagement.ts`、`AcpTeamApprovals.ts` / `packages/experimental/agent-team`、`client-ui-agent-team`                 | 使用原生 agentTeam、sessionStatus、成员导航和 send_message；保留 ACP 模式、成员模型、批量审批和绑定检查。原生只读名单不能覆盖这些写入能力                                         |
| 子 Agent 与官方 bundle           | `src/host/subagent` / `packages/subagent`                                                                                                    | 原生 spawn/fork 有可续聊 Session；Codex app-server、Claude SDK、ACP 和 DSH SDK 外部委派只返回结果。保留真实观测的只读投影，不把最终摘要伪装成完整流，也不把主会话降级为一次性任务 |
| 模型、推理、模式                 | `member-models.ts`、`agent-session-controls.ts` / `packages/client/ui-model-selection`、`packages/api/api-session-controller`                | 主模型和推理由原生选择器管理；ACP 专有配置沿用原生 Menu。成员待生效模型与持久化绑定继续由适配器处理，避免重复模型入口                                                             |
| 聊天流、思考、分组、折叠与滚动   | `AcpAssistantStream.ts`、`acp-chat-normalization.ts` / `packages/client/ui-chat`、`ui-conversation`                                          | 保留完整原生组件树、viewport hooks、公开 builder 与分组状态；ACP 只接入数据投影，原生详细度和折叠设置继续生效                                                                     |
| 工具树、命令、文件差异、交付     | `AcpActivityNode.ts`、`native-tool-renderer.ts` / `packages/client/ui-tool`、`ui-toolview`、`ui-primitives`、`tool-present`                  | 使用原生 ToolCallTree、TerminalBlock、DiffBlock 与文件卡；事实不足时回退通用详情，不伪造退出码、工具执行事件或原生 turn 文件变更                                                  |
| 恢复面板、诊断、反馈、字体与键盘 | `AcpRecoveryDock.ts`、`AcpAuditHeaderAction.ts`、`AcpAgentControl.ts` / `packages/client/ui-primitives`、`ui-theme`                          | 继续使用原生 Modal、Menu、DisclosureRow、JsonTree、Toast 和主题角色；修复关闭菜单后的失败可见性及诊断正文的固定字号。原生小型菜单与表格字号保持原有规则                           |
| 构建、测试、CI、发布             | `scripts`、`.github/workflows`、`test/e2e` / 官方 Loader、Web scaffold 和开发 workflows                                                      | 保留精确发布依赖、产物检查、分片和普通用户平台检查；迁移失效的模型菜单与 Schedule 夹具。只运行受本次改动影响的本地检查，CI 负责平台矩阵                                           |

## 本轮改动

1. 空白重绑定仅恢复本次宿主有效消息投影中、来源明确的 AGENTS 指令，保留顺序和替换/删除语义，排除当前已准入消息的重复项。普通用户历史、其他来源及已从有效投影移除的指令不重放；正常续聊、已有会话恢复和 Steer 不因此增加传输。
2. 会话选项与 DSH 工具策略的写入失败使用已有全局 Toast。会话选项的写入错误与读取失效分开，重新打开菜单不再误触发读取重连并立即关闭。读取失败保留现有重试行为，迟到结果继续受会话/epoch 检查；不增加每次成功选择的通知。
3. 诊断原始正文使用官方 small-code 字体角色，使代码字体设置生效；不修改全局间距或小型 UI 的字号规则。
4. 文件读取的审计原因和写入的并发冲突判定使用稳定标识。错误消息不再决定这两类状态，IO、超时、取消和真实并发保护保持各自语义。
5. 浏览器回归沿用 alpha.2 实际模型菜单入口及 Schedule 组合；Windows 普通用户检查分别观察子进程结果与 ACL 清理结果，不将一项掩盖为另一项。

## 官方 skills 的采用

本仓库继续维护少量适配后的 workflows，不复制 DSH 整套 `.agents/skills`。对照 rc.2 与 alpha.2：`dsh-code-review` 新增结构化错误处理核对，`dsh-client-ui-ux` 接入同一错误处理原则，`dsh-error-handling` 为新增 workflow；`dsh-find-simplifications` 进一步要求保留失败状态及安全继续的依据。`dsh-pre-push-checks`、`dsh-ci-test-reliability`、`dsh-prose-standard` 在两版本之间没有内容变化。

采用到本仓库的重点是：每个维护对象有当前消费者和明确所有者；预期失败有稳定标识；捕获异常不等于恢复，只有状态所有者确认安全才能继续；已提交与未知结果分开；错误提示可见、可操作且本地化；变更的实际入口、取消、清理和负面控制有适当证据。规范同时约束代码审查和后续业务功能的源码对照。

DSH 的 monorepo 命令、100% 覆盖率门禁、专属快照目录、组织设计审批、Agent Notes/stack 管理和无限真实模型额度不导入本插件。仓库与用户现有授权、实际构建链和测试说明仍是执行依据。skills 的修改不为产品用户增加配置或使用步骤。

## 用户决策成本复核（2026-10-11）

审查起点为插件 `94977fd`，上游仍固定 `d743267`。三名协作审查者分别负责实验加载、产品流程和官方 skills/notes，root 交叉检查生产入口、工具桥、持久化及修复。完整实验库存和条件加载表见[实验集成审计](dsh-0.2.1-experimental.md)。本轮未修改用户 profile、认证、数据或默认实验开关，也不发布或合并。

不能笼统承诺“用户没有任何决策成本”。上一轮实验兼容没有新增 ACP 实验开关、模型路由、语音设置或迁移步骤；现有 ACP 安装与权限边界仍有必要选择，恢复和原生权限适用性也存在可以减少的负担。

| 完整流程                       | 当前实现与必要选择                                                                                                    | 审查结论 / 应采取的方向                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装、认证、Agent 目录         | 原生插件安装 + 选择外部 Agent；Agent CLI 自己认证，registry 预填已知命令/参数                                         | 保留这项真实能力差异，不强制转为官方后台 bundle；无需再次安装/同步私有 skills。Antigravity 默认配置按用户要求暂缓                                                                  |
| 连接配置与健康检查             | 原生配置表单，环境变量遮蔽，检查结果说明可执行文件、认证与协议状态                                                    | 不引入另一套实验配置；未知默认值不编造。已预填的通用模板仍可能展开 ID/命令/参数，登录指导又藏在高级项，尚需改善正常路径的可发现性；官网链接不能被当成完整安装指导                  |
| 主模型、思考、搜索、Agent 模式 | 主模型/推理由原生 picker 负责，Agent 会话菜单保留协议提供的其他设置                                                   | 避免相同 model/effort 的重复入口；不同 Agent 提供的真实 mode 仍需保留，不把执行选项藏进实验菜单                                                                                    |
| 原生权限 preset                | ACP 输入准入保证真实 `danger-full-access` + `ask`；默认无匹配 preset 时原生显示 Custom，Agent 自有权限仍由 Agent 管理 | 存在适用性缺口：不匹配的 preset 可在下一轮变回 Custom，不能承诺所有选择都生效。Auto 自身就是相同权限组合，因此仍保留并触发不兼容的 reviewer；需要原生按 Session 的可用性/说明 seam |
| DSH 工具自动批准 / Ask         | ACP 会话策略控制已注册且本会话可见的 Host 工具，已挂起请求仍由用户处理；成员继承 Lead                                 | 是既有功能，不是新实验开关。不要同官方 Auto Review 的模型风险评审混称，也不能用它替代 Agent 自有工具审批                                                                           |
| 工具权限与固定选项问答         | 复用原生审批；Codex 持续授权等超出一次性卡片的范围用问答承载                                                          | 明确选择是权限的一部分，不能为减少点击而默认批准或把持续授权降为一次性。不增加普通草稿/语音入口到固定权限表单                                                                      |
| 输入、排队、续聊、取消         | 原生 inbox/composer；ACP 按协议能力决定续发路径，Stop 保留已有语义                                                    | 无第二套 Queue/Steer 开关，不要求用户判断传输策略；仅已确认安全的重连/本地结算自动继续                                                                                             |
| 共享指令与 skills              | 消费 DSH 已发现/组装的指令与当前 skill 工具，空白重绑补有效 AGENTS                                                    | 无目录复制、同步器、额外配置或技能菜单；skill 内容不授予工具权限                                                                                                                   |
| 工具目录、MCP、PTC、图像       | 每轮按准入 schema 与实际 scope 暴露一种 native/PTC 入口；图片正向能力需当前连接证明                                   | 无手动能力开关；未知能力不谎报 text-only，也不承诺高级 Browser/Computer provider 已验收。目录变化可能重建进程，不支持 resume/load 的 Agent 仍有恢复成本，应明确原因                |
| 翻译、语音、检索、终端、Ralph  | 官方 bundle、renderer、composer、工具与 workflow；原生实验开关是唯一入口                                              | 无本插件新增的选择。语音准备/设备授权、Ralph 的人类明确请求属于各官方功能本身的使用条件，不应称为完全零成本                                                                        |
| Worktree、工作目录             | core cwd guard 常驻；支持 fork 时自动交接远端上下文与持久绑定，不支持则在副作用前拒绝                                 | 不提供“空白继续”来掩盖上下文丢失。已知 pending 自动续接，派发结果未知仍停止并保留审阅边界                                                                                          |
| Teams、成员模式/模型/审批      | 原生名册/任务板/导航；ACP 另保留官方只读名单不能承担的成员写操作                                                      | 原生团队入口与 ACP 管理入口尚未合并。本轮修复热关闭残留；统一扩展位置、关闭弹层后仍可见的写操作反馈尚需优化。批量管理要求 ACP lead 与同 provider 成员，不扩大为所有混合团队        |
| 会话恢复                       | 正常本地补存与恢复读取失败自动处理；真实未知结果、上下文丢失需要明确决策                                              | 当前弹窗恒定三选且“新建”总是 primary，即使 Host 已知重连必然失败。应由 Host 返回可用动作/前置条件和推荐次序，隐藏无效操作；不能在客户端解析错误文字猜测                            |
| 原生辅助命令与自动标题         | 原生 `/compact` 和标题可默认继承当前模型路由；ACP 只接受正常交互会话准入                                              | `/compact` 有可压缩历史时也会因辅助调用被拒绝而失败；独立 summarizer 只压缩 DSH surface，不压 ACP 私有 context。不能要求用户增加模型配置来证明默认兼容                             |
| 诊断、历史与展示               | 原生折叠/字体/主题、准确 diff/plan、按需详情和 ACP 诊断；历史自动兼容，无清理步骤                                     | 不增加默认诊断任务或“先导出再使用”门槛；保留 Agent 内部操作与 DSH 原生记录的可观察性区别                                                                                           |

### 当前确认的体验缺口

1. **Teams 热关闭残留。** 初始未开启时组件不发 Teams RPC，也不显示入口；但热关闭后原生投影 registration 的移除不发 projection-change，浏览器旧 `agentTeam` 可保留到新 baseline。原先 ACP slots 常驻，打开残留入口会遇到 Host service 已不存在。本轮让 ACP Teams 入口跟随官方 `agent-team` UI contribution 生命周期，而非把缓存投影当作启用事实；没有新增开关。
2. **恢复动作缺少 Host 可用性。** `AcpRecoveryDock` 对所有 kind/cause 固定三选；`retryOriginal` 对当前 cwd/launch fingerprint 不匹配会在 restore 前拒绝。正确方向是复用同一 Host preflight 返回动作与安全前置条件，先提供可用的保留上下文路径，再渐进呈现放弃上下文的替代项。能力、目录或配置恢复后可重新变为可用，因此不能只按历史 cause 永久禁用。`outcome-unknown` 不得自动重发；本轮记录缺口，尚未实现新接口或更改恢复选择。
3. **原生权限选择对 ACP 的适用性不明确。** 官方 Auto Review 为进程级 catalog；Auto 的 `danger-full-access` + `ask` 与 ACP 投影一致，原生 derive 会保留 Auto，所以 idle 和运行中选择都可能进入 reviewer。原生 input 不因 running 锁定。reviewer 的 `llm.stream` 缺少 ACP Session/准入身份，会导致工具被拒绝而非风险评审成功；其他不匹配的 preset 则可能在下一次 ACP claimed 后变为 Custom。标题默认继承 ACP route 时同样不能执行辅助调用。这是已确认的不兼容，不只是“没有默认启用”。`catalog()`、`registerAuto(admit)` 和 preset option 均没有按 Session 的可用性/禁用理由；仅 `/permission` command shadow 也不能覆盖直接 set/restore。本轮不篡改全局 catalog、不伪造辅助调用身份、不增加原生模型凭据；需要官方提供按 Session 的 preset 适用性、Host 准入检查及独立 reviewer route seam，或另行审查明确的产品处理方式。
4. **Teams 写入结果仍可能随面板消失。** 批量中断/模式结果留在 `AcpTeamManagement` 弹层内，`TeamMemberModelControl` 卸载后会抑制迟到结果。可复用现有 shell overlay Toast，由长期 owner 承载操作结果，查询失败、Retry 与逐成员明细仍留在面板中；需核对关闭后的成功/失败与旧会话迟到结果。本轮生命周期修复不等于该反馈问题已解决。
5. **原生 `/compact` 没有过滤辅助调用能力。** [`command-compact`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/command-compact/src/index.ts#L101) 全局注册命令，[summarizer](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/summarizer.ts#L137) 默认取当前 route，传 `purpose: compaction`。ACP 明确拒绝辅助 compaction；没有可压缩区间时返回成功的 no-op，有区间后才会暴露失败。另配原生 summarizer 增加模型配置成本，且仍不压缩 ACP 私有 context。该问题应与原生辅助命令的按 Session 可用性一起处理，不能承诺所有原生命令等价兼容。
6. **正常配置路径的指导与工具变更说明不足。** 已预填模板的额外字段和藏在高级项的登录指导属于可发现性问题；工具目录 key 变化或 lease 失效可能重建 ACP 进程，不支持 resume/load 的 Agent 会进入 recovery。应由实际状态所有者说明准备条件与触发原因，不能靠用户试错、隐式空白重绑或取消安全门禁降低表面点击量。本轮仅记录，未更改配置与恢复流程。

以上区分了当前修复、应继续优化的产品接口和不能隐式跨越的权限/上下文边界。没有以新增用户开关解决内部加载问题。

## 官方 skills 与 notes 的完整覆盖

官方目录实际为 `.agents/skills` 和 `.agents/notes`。主技能共 16 个入口：15 个常规 `SKILL.md` 和一个 `agent-experience` 符号链接入口，正文均已阅读；20 个辅助文件（18 Markdown、2 Python）已枚举并按需引用，未对每个辅助脚本进行实现审计。按日期命名的英文 Agent Notes 共 1,224 篇：251 implemented、41 proposed、8 rejected，即 300 active；924 archived 仅核库存，不用作当前机制依据。中文与 sidecar 的 1,224 套配对不等于本轮逐句翻译审校。

全部 active 的路径、状态、标题和 Decision/Proposal 已检索、按单一主域归类，相关生产者与消费者再回到固定源码深读。交叉主题只计一次，避免重复制造覆盖率：

| 主域                 | implemented / proposed / rejected | 核对到本插件的业务                                              |
| -------------------- | --------------------------------- | --------------------------------------------------------------- |
| UI、导航、渲染       | 21 / 2 / 0                        | 原生 slot/locale、reasoning、字体、折叠、侧栏、Toast、菜单边界  |
| 会话、持久化         | 40 / 12 / 4                       | projection、Sidecar、dispatch、fork、恢复、历史保留、可忽略事件 |
| 团队、子代理、工作流 | 13 / 0 / 0                        | 激活身份、父子归属、成员写操作、取消/排空、Ralph                |
| 审批、安全           | 17 / 0 / 0                        | 原生 preset、ACP 自有权限、Host 工具审批、问答和授权范围        |
| 工具、执行、资源     | 34 / 3 / 0                        | native/PTC、MCP、文件/终端、目录、进程、图片及资源释放          |
| 工程、测试、文档     | 44 / 8 / 2                        | 精确依赖、产物、最小验证、CI 可靠性、文档事实所有者             |
| 插件、配置、实验加载 | 30 / 5 / 1                        | profile/bundle、Loader、manifest、enable/disable、配置版本      |
| 桌面、发布平台       | 7 / 3 / 0                         | 桌面尚待稳定版本的验收边界；不继承主产品签名/更新系统           |
| 模型、思考、上下文   | 17 / 2 / 1                        | 原生模型选择、ACP current model、辅助调用、指令及上下文用量     |
| 输入、提示、指令     | 17 / 5 / 0                        | composer、inbox、Queue/Steer、共享 AGENTS、skill 工具           |
| 错误、取消、可观测性 | 11 / 1 / 0                        | 类型化错误、安全继续、未知结果、生命周期及可见反馈              |
| **合计**             | **251 / 41 / 8 = 300**            | **这是检索/相关性覆盖，不是 300 个机制的运行验收**              |

采用方式继续保持三个本仓库 workflows，不把 16 个技能入口变成用户或开发者每次必须选择的菜单：

- `dsh-code-review`、`dsh-client-ui-ux`、`dsh-find-simplifications`、`dsh-error-handling`：进入 `adapter-review`，新增逐流程决策成本、条件加载与激活区别、notes 状态和最强保留理由。界面优先复用原生入口；预期失败按稳定类型处理，不能靠展示文字决定是否安全继续。
- `dsh-pre-push-checks`、`dsh-ci-test-reliability`：进入 validation/release，沿实际产物和拥有用例选最小检查。本轮补实验启用、关闭、晚挂载、撤销和清理的验证要求，不重复未变输入的全量 CI。
- `dsh-speed-up-perf`：性能任务才使用端到端用户指标、同输入前后对比和负面控制，不为每次提交新增 benchmark。
- `agent-experience`：初始上下文保持必要信息，延迟详情有明确可发现入口，权限/破坏性影响在动作前可见，每个事实只表达一次；模型可见定义变更时比较首轮 prompt 成本及总工作量。用这些原则减少错误调用与用户补充说明，不为产品增加选择。
- `dsh-prose-standard`、`dsh-trim-cot-leakage`、`dsh-doc`、`dsh-create-upgrade-guide`：沿读者任务、一个事实一个 owner 和行为变化同步迁移说明整理文档，保留能在仓库当前版本核实的事实。本轮也对齐原生复用中英文页面的图片和 Worktree 说明；`dsh-translate-docs` 仅按明确翻译需求使用，不扩展本插件的翻译流水线。
- `dsh-archive-agent-notes`、`dsh-merging-stacked-prs`、`record-browser-gif`：借鉴状态、替代方案、真实单次证据及遮密原则；不导入整套 notes 三件套/冻结 manifest、stack/组织审批或付费模型 GIF 门禁。

关键当前依据包括 [optional bundle 的边界](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)、[原生或 PTC 单一呈现](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/simplification/2026-10-05-native-or-ptc-presentation.md)、[协作式取消](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md)、[runtime 身份](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.md) 和 [Session reader 兼容审查](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md)。它们指导所有权、可观察行为和最小修复，不授权把官方 Session 私有写接口当作外部插件 API。

`semantic-composer-chain-phases`、`composer-model-and-draft-editor`、`logical-session-storage-rebuild`、`session-capability-protocols` 和 attachment quarantine 仍在 proposed；不能据此假定已经有新 composer phase、双编辑器或 Session capability API。rejected 的历史截断、durable step 删除、持久化接口合并及 skill registry 删除则用于核对保留理由。小型本地修复使用现有代码/测试/文档所有者，不为覆盖数量另建一套 notes 索引。

审查清单与分类数据保存在 gitignored `.local/ux-notes-audit.json`、`.local/experimental-loading-inventory.json`；上述范围及限制保存在本页，避免把未提交的临时证据当作唯一说明。

## 明确保留与后续条件

不将官方外部子任务的自动权限策略套到交互式人工审批，不用一次性 `SubagentRun` 替代持久 ACP 会话，也不以官方 SDK 消费了流为由声称 UI 已展示完整子会话。直接 app-server / Claude SDK 的完整聊天后端是另一项产品能力，本轮不扩大到该范围。

不删除 Sidecar、不改写用户历史或认证、不将 ACP 文件访问改成具有不同字节与并发语义的宿主文本工具。共享 AGENTS 与 skills 的文件发现、去重和加载仍归宿主；本插件只处理跨 ACP 会话的传递。

新增官方能力今后按本表对应领域追踪：源码入口与消费者 → 行为差异 → 用户负担与保留能力 → 可删除的维护工作 → 最小验证 → 原生 UI 冲突检查。仅有版本更新或“官方已有类似功能”不足以决定替换。

## 测试流程与耗时

上一轮 [CI 37949539479](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37949539479) 从创建至结束约 15 分钟。其中三个独立 runner 的 Host 构建各约 2–2 分 39 秒，浏览器用例各约 5 分 38 秒–8 分 48 秒；macOS/Linux 的完整 npm 兼容检查分别约 3 分钟和 3 分 41 秒。Windows 约 5 分钟后因清理失败结束。这次记录不能证明用户感受到的一个多小时由单次 CI 造成，也不能作为修复后的耗时承诺。

本轮消除失效夹具及清理错误导致的重复排查，并把本地操作文档对齐已采用的 library 构建入口。开发时按受影响行为选择检查，平台全量由 CI 执行；已经通过且输入未变的本地检查不因提交再重跑。保留精确依赖、实际产物与独立安装检查，不用减少验证范围来制造提速。发布仍验证同一 tarball，本轮不运行发布，也不改变发布门禁。

本轮完整成功 [CI 37958222030](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37958222030) 用时 11 分 12 秒，三个浏览器分片各约 6 分 52 秒–7 分 33 秒，Host 构建各约 2 分 15 秒–2 分 21 秒。Windows 普通用户安装、检查、打包及清理约 3 分 48 秒。两次 CI 的失败状态、缓存与 runner 条件不同，这是一条成功执行记录，不能据此承诺固定提速比例或端到端发布耗时。

## 验证记录

2026-10-10 本地输入：Node `24.19.0`、插件 pnpm `10.7.0`、精确发布依赖 DSH `0.2.1-alpha.2`，源码 scaffold 固定为上述 `d743267`，未改 lockfile、Registry 快照或用户 profile。

| 检查                     | 结果与范围                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`         | 通过：产品、单元测试、脚本及 mock Agent 类型                                                                                                                                                                                                                                                                                                                  |
| 定向单元测试             | 9 个相关文件分批通过，覆盖文件读写、空白重绑定、prompt/context、UI 注册与反馈、架构约束；后续 UI 修正再次通过其 2 个 owning 文件                                                                                                                                                                                                                              |
| `pnpm build`             | 通过：类型编译、Typert、bundle、244 个包文件及 92 个运行时 JavaScript 产物闭包、严格公共声明消费者                                                                                                                                                                                                                                                            |
| `pnpm test:e2e` 定向检查 | 10 个用例分批通过：4 个 Agent 目录恢复、3 个 Schedule、恢复队列、Codex response controls、Devin diagnostics；每次先检查完整 E2E 类型与准确 scaffold。过滤未选中的用例不计作本地通过                                                                                                                                                                           |
| UI 截图与实际样式        | 已检查菜单关闭时的失败提示、420px 菜单与 Toast、诊断明暗主题；11/16px 字号及 16/21px 行高、官方字体回退链、表格字号、无横向溢出均由真实浏览器断言                                                                                                                                                                                                             |
| 格式、diff               | 改动文件格式检查及 `git diff --check` 通过                                                                                                                                                                                                                                                                                                                    |
| 平台 CI                  | [`37958222030`](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37958222030) 在代码提交 `1231cbd3f590c52c59433b283a0a38b3f69d237d` 全部通过：Linux/macOS/Windows npm 兼容、三个完整 keyless 浏览器分片及汇总门禁。Windows 131 个文件、1435 个单元用例通过，普通用户退出码为 0；Developer Mode、工作区 ACL、普通账号及临时目录清理逐项成功 |

新增回归曾揭示三个需要修正的假设或行为：Schedule 工具注销会关闭整个 MCP lease，而非在旧连接返回空目录；官方字体保留完整 fallback；会话选项写失败曾误触发读取重连并关闭菜单。前两项按真实所有者修正夹具，后一项在产品中区分读写错误；对应用例修复后均通过，没有加入重试。

上一轮 CI `37949539479` 的 macOS/Linux npm 兼容检查及浏览器分片 1、3 通过；分片 2 有失效的模型菜单/Schedule 夹具，Windows 在测试和打包通过后发生 ACL 清理错误。该 CI 不能记为整体通过。空白重绑定的指令补发使用 durable Sidecar + mock runtime 单测验证，恢复队列另通过 Loader/浏览器检查；真实 Agent、模型用量和完整桌面安装包未因本次优化重新验收。

## 实验加载与体验复核的修复、验证（2026-10-11）

本次从 `94977fd` 开始的复核另有两项代码修复：Teams 管理/审批 contribution 随官方 `agent-team` UI owner 的注册、卸载和替换收敛；fork 的派发前失败改用 `AcpForkPreDispatchError` 与稳定 code，保留 cause。远端 RPC 即使返回同样的错误文字，也不能被误判为“尚未派发”并进入 fresh fallback。这直接采用官方错误处理与安全继续原则，没有新增用户配置。

| 本次检查                            | 实际结果与边界                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Teams 生命周期与客户端注册单测      | 2 文件、6 项通过：默认关闭、迟到启用、无关 contribution、关闭/再开、owner 替换及停止清理                                                                                                                                                                                             |
| fork runtime、Host fork 与 cwd 单测 | 3 文件、32 项通过；真实 stdio 夹具核对 fork 请求是否派发、身份前置条件、intent cause 和远端同文错误。日志 `.local/typed-fork-unit.log`                                                                                                                                               |
| fork 负面控制                       | 临时恢复旧文字分类后，3 个远端同文反例均失败；恢复类型分类后通过。日志 `.local/typed-fork-negative-control.log`                                                                                                                                                                      |
| 类型与构建                          | `pnpm typecheck`、`pnpm build` 通过；247 个 dry-run 包文件、93 个运行时 JavaScript 闭包及严格公共声明消费者通过。日志 `.local/experimental-audit-typecheck.log`、`.local/experimental-audit-build.log`                                                                               |
| Host/Chromium                       | `pnpm test:e2e test/e2e/product-controls.e2e.ts test/e2e/worktree-tools.e2e.ts`：2 文件、4 项通过，17.29s。含默认关→开→保留 Host roster/缓存投影只关闭原生 UI→再开→完整 bundle 关/开，以及真实 Git/fork 和不支持 fork 的零副作用拒绝。日志 `.local/experimental-audit-e2e-final.log` |
| 格式与变更完整性                    | 改动文件 Prettier 与 `git diff --check` 通过                                                                                                                                                                                                                                         |

本次总计 38 项定向单测与 4 项 Host/浏览器用例通过。首次 E2E 在类型阶段发现新断言误用了非本项目 matcher，尚未启动 Host；改为项目既有 `expect.poll` 数量断言后，完整 E2E 类型与上述用例通过，未放宽业务断言。没有启动全部 11 开关的 on/off 矩阵、真实 Agent、外网模型或完整桌面；本次构建并非新的发布产物，未重跑独立 npm 安装或全平台 CI。前文历史 CI 与 tarball 只证明其记录输入，不作为这两项新修复的全平台通过证据。当前确认的其余体验缺口保持明确待办。
