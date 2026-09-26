# dsh-context-management

[English](./README.md) · **简体中文**

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 checkpoint 换窗、会话私有笔记和分页历史检索插件。借鉴 Codex 的多窗口思路，**不是 Codex API 的 1:1 移植，也不保证模型无损恢复全部语义**。

## 当前适配

版本 **0.3.0**，已针对 **DSH 0.1.7-alpha.1 / 0.1.7-rc.2 / Node.js ≥ 22.15** 验证。peer 范围为 `>=0.1.7-alpha.1`（不设上限）：DSH 0.1.7-rc.1 起会在启动时跳过 peer 范围不含当前版本的插件，设上限会让插件在 DSH 升级后被静默跳过；升级后跑一遍测试即可。

- 通过 DSH 官方扩展点工作：`@local/dsh-context-management/compaction` 是 `BasicCompactionEngine` 的子类，重写官方子类钩子 `summarize()` 和动态分派的 `compactIfNeeded()`；不 monkey-patch 实例方法，不读取 Cordis 内部结构。
- 复用原生的工具调用配对检查、保留近期对话、并发维护锁、取消、缩减检查、压缩事务、落盘和 overflow 重试。
- 自动压缩仍由 DSH 原有回调驱动，插件不另建压缩循环。
- 宿主插件发布 `contextWindows` 服务（会话状态与设置）；preset 里的引擎按调用查找它而非 `inject`。宿主缺席时引擎行为与原生完全一致，preset 不会因依赖缺失而失去压缩。
- 只有挂载了该引擎的 preset 才能用 `new_context`；其他 preset 调用会明确报错，notes/history 工具仍可用。
- 只有 DSH 真正提交替换消息，窗口编号才推进。失败、取消和无可压缩历史不会假报换窗成功。
- 换窗交接优先使用模型在本窗口写入的 `checkpoint.md`。没有新 checkpoint 时，默认（`handoffSummary: generated`）调用**一次**原生摘要模型，把摘要放进 `<generated_handoff>`，并与目标、待办、近期用户指令和窗口目录一起组成交接；`compaction/summary` 事件记录真实摘要模型的 provider/model/usage，费用统计可见。摘要调用失败时退回截取式交接，不阻塞换窗。`handoffSummary: extractive` 完全不额外调用模型。停用插件或工具时回退原生摘要生成。

## 工具

| 工具 | 作用 |
| --- | --- |
| `new_context` | 请求在下一个安全 step 边界换窗（可附带 `notes_summary`） |
| `notes_write_file` / `notes_append_to_file` / `notes_read_file` / `notes_list_files_by_prefix` / `notes_search_contents` | 会话私有笔记，跨换窗与重启保留 |
| `history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents` | 分页检索本会话的完整原始历史 |

## 使用

`/ctx`（别名 `/ctx-mw`）切换开关；`/compact` 执行当前压缩方式。开关作用于**当前 DSH 实例的所有会话**，不是某个聊天标签。

模型调用 `new_context` 时，返回的是 **requested**，不是 reset：先保存可选的 `notes_summary`，再安排下一安全 step 边界换窗。本步工具结果会先完整写入历史。若 DSH 的 `auto` 关闭，插件仍处理显式换窗请求。

网页“上下文管理”页使用 DSH 0.1.7 的 `configForms`，与 `/ctx` 共用后端设置。读取失败、只读连接和保存失败不会伪装成切换成功。设置修改无需重启；**升级插件代码后，运行中的 DSH 仍需要重载插件或重启，并刷新网页**。

## 保存与恢复

历史直接读取调用者自己的不可变 DSH 会话日志：

- `item_<seq>` 是稳定事件地址，不重复索引、不因条目数超过 2,000 而丢弃旧记录。
- 原生工具结果通过 call ID 关联名称；`tool/code-dispatch`（PTC）也可检索。
- `history_read_item` 的 `format: "json"` 可分页读取完整原始事件，包括调用参数和元数据。
- 每个窗口按原生 checkpoint 替换事件划分。保留尾部的旧事件仍归属于其最初产生的窗口。

笔记按会话隔离，默认路径为 `self/notes/<path>`，**不开放任意跨会话读写**。文件位于插件自有目录 `$DSH_HOME/context-management/notes/<sessionId>.json`（`$DSH_HOME` 由 `dsh-home-paths` 解析），不依赖会话持久化后端的私有布局；使用 DSH 原子写入与跨进程文件锁。失败不会把未保存状态替换进缓存。

笔记按需加载，不在启动时读取全部会话。恢复后重建窗口元数据并加载该会话笔记；未完成的临时换窗请求不会因重启而重新执行。

备份或迁移时需同时包含 `context-management/notes/`；**删除会话不会自动删除其笔记文件**。分叉会话的笔记独立，父会话笔记不会隐式共享。

## 效率与边界

| 操作 | 默认值 / 硬上限 |
| --- | --- |
| 换窗交接（`checkpointMaxChars`） | 默认 12,000 字符，可设置 4,000–16,000 |
| 注入笔记 | 最近最多 8 个，每个最多约 1,800 字符，仍受交接总预算限制 |
| 单文件笔记 | 1,000,000 UTF-8 字节 |
| 每会话笔记总量 | 64 个文件 / 4,000,000 UTF-8 字节；超限明确拒绝，不静默淘汰 |
| 历史列表 / 搜索 | 默认 20 条，最多 50 条；每条默认 400 字符，最多 1,000 |
| 每页历史扫描 | 最多 2,000 个事件或约 2,000,000 个内容字符；单个大事件会完整检查 |
| 每页历史预览 | 累计最多 12,000 字符，另加条目元数据 |
| 历史 / 笔记正文读取 | 默认 8,000 字符，最多 20,000 |
| 笔记搜索 | 最多 10 个文件 × 5 行；每行最多 400 字符 |

历史查询返回 `has_more` 和 `next_cursor`；继续查询时保持过滤条件与顺序。正文读取使用 `next_offset_chars`。搜索默认区分大小写，可设置 `case_sensitive: false`。

上下文中的近期用户指令按时间顺序保留并标明事件地址，后续修正优先。checkpoint 同时保留活动 goal、未完成 todo 和有限笔记。具体原始证据通过历史工具恢复。

预算提醒以原生压缩阈值为基准，每窗口至多一次。实际压缩阈值、保留尾部大小和 provider overflow 重试仍使用 DSH 的配置；该提醒不是精确的模型剩余容量声明。

## 安装

本插件未发布到 npm，包名 `@local/dsh-context-management` 表示本地插件。以 web profile 为例：

1. 克隆并安装依赖：

   ```bash
   git clone https://github.com/overact/dsh-context-management.git
   cd dsh-context-management && npm install
   ```

2. 在 profile 目录（`$DSH_HOME/profiles/<profile>/`）的 `package.json` 的 `dependencies` 中加入本地链接，然后在该目录运行 `pnpm install`：

   ```json
   "@local/dsh-context-management": "link:<插件目录>"
   ```

3. 在 profile 的 `cordis.patch.yml` 中注册插件（见下方配置）。

4. 让 Web preset 挂载换窗引擎（见 [DSH Web preset 作用域](#dsh-web-preset-作用域)）：

   ```bash
   node scripts/sync-presets.mjs --profile web
   ```

5. 重启 DSH 并刷新网页。

## 配置

```yaml
- insert:
    - id: context-management
      name: '@local/dsh-context-management'
      config:
        enabled: true
        overrideCompaction: true
        injectTools: true
        defaultStrategy: window      # 或 native：未在 modelPolicies 中列出的模型使用原生摘要
        modelPolicies: []            # 例：[{ provider: deepseek, model: deepseek-chat, strategy: native }]
        reminderTokens: 6144         # 1024–32768
        handoffSummary: generated    # 或 extractive：无额外模型调用
        checkpointMaxChars: 12000    # 4000–16000
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 启用上下文管理（当前 DSH 实例的所有会话）；`/ctx` 切换的就是它 |
| `overrideCompaction` | `true` | 用 checkpoint 和历史检索替换原生摘要生成 |
| `injectTools` | `true` | 启用 notes/history/new_context 工具；关闭时使用原生摘要压缩 |
| `defaultStrategy` | `window` | 默认压缩策略；`native` 让未列出的模型使用原生摘要 |
| `modelPolicies` | `[]` | 按精确 provider/model 覆盖策略，首个匹配项生效 |
| `reminderTokens` | `6144` | 在自动压缩阈值前预留的 checkpoint 提醒预算 |
| `handoffSummary` | `generated` | 模型未写 checkpoint 时的交接方式 |
| `checkpointMaxChars` | `12000` | 换窗交接内容的最大字符数 |

`injectTools: false` 会移除工具并使用原生摘要，避免裁剪之后无工具可恢复历史。`overrideCompaction: false` 保留 notes/history 工具，普通自动压缩和 `/compact` 使用原生摘要；模型仍可显式请求 `new_context`。

卸载宿主插件会移除工具、设置注册和 `contextWindows` 服务；preset 中的引擎随即回到原生摘要行为。

### DSH Web preset 作用域

Web 宿主不提供全局 `compaction`，压缩引擎位于各 preset 的隔离作用域。Loader 无法按 id 修改 preset `config.plugins` 里的子行（只有 `group: true` 列表会被索引），patch 也不能改行的 `name`。因此由 `scripts/sync-presets.mjs` 把 `dsh-web-app` 自带的、挂载 `dsh-compaction-basic` 的 preset（当前为 standard/ptc/cordis）**整行复制**到 profile patch 的生成块中，只把那一行换成 `@local/dsh-context-management/compaction`；profile 自己定义的 preset 原地替换。

```bash
node scripts/sync-presets.mjs            # 生成/刷新（写入前保存 cordis.patch.yml.pre-sync）
node scripts/sync-presets.mjs --check    # 生成块与已安装 DSH 不一致时退出码 1
node scripts/sync-presets.mjs --remove   # 删除生成块并恢复原生行，完全回滚
```

**每次升级 DSH 后必须重新运行**，否则这三个 preset 会停留在旧版本定义。建议在 DSH 的启动脚本里运行 `--check`，过期时在日志中告警。不要在网页编辑器里修改 standard/ptc/cordis：脚本发现生成块外存在同 id 覆盖时会拒绝写入。

## 验证

```bash
npm install
npm run verify
```

测试需要 DSH 开发依赖；也可用 `DSH_PACKAGE_DIR` 指向已经安装的 `@deepseek-ai/dsh` 包目录。所有模型响应均为固定本地 fixture，**测试不调用付费模型**。使用单进程 Node test runner，避免重复启动 DSH 测试运行时。

验证覆盖真实 Cordis 生命周期、DSH ToolRuntime、SettingsProvider、TokenMeter、BasicCompactionEngine、JSONL 磁盘恢复，以及网页设置绑定、会话隔离、工具配对、取消、失败路径和容量限制。网页测试检查状态/写入契约，不等同于完整浏览器视觉测试。

历史读取是增量的：10,000 条合成事件的首次状态构建约 2.5 ms，未变化时重复读取扫描 **0 条事件**（绝对时间仅供参考；回归测试约束的是增量读取、扫描上限和输出上限）。

0.3.0 在 DSH 0.1.7-rc.2（及回滚目标 0.1.7-alpha.1）上通过 57 项测试。

## 许可证

[MIT](./LICENSE)
