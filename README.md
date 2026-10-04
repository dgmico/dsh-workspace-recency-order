# dsh-workspace-recency-order

按「工作区里最新一次会话活动时间」自动重排 DSH 左侧工作区顺序：**最近聊过的排最上面**。

排序是持久的、实时的。你在某个工作区发一句话，它会自动浮到第一位；重启 DSH 后顺序保持，并继续自动维护。

---

## 它怎么做到不覆盖官方 UI

DSH 浏览器端渲染工作区分组时，是**照着 Host 传过来的工作区数组顺序**依次铺开的
（`dsh-client-ui-workspace` 的 `groupByWorkspace` 直接 `for (const workspace of workspaces)`，
不做二次排序）。所以只要改 Host 那边的权威顺序，左侧列表就会自己跟着变。

本插件是纯 **Host 侧插件**：

- 读 `ctx.workspaceRegistry.list()` 拿到工作区及其会话归属；
- 读 `ctx.sessionController.list()` 拿到每个会话的 `updatedAt`；
- 算出期望顺序，和当前顺序不一样时，调用官方的
  `ctx.workspaceRegistry.insertBefore(workspaceId, beforeWorkspaceId)` 写入。

不替换任何 Slot、不碰任何官方组件、不注入 DOM。写入走的是官方持久化路径，Host 随后照常
广播 `order` 增量，所有已打开的客户端（包括你正在用的这个）都会跟着更新。

## 排序规则

对每个工作区，取**它名下所有会话里最新的 `updatedAt`** 作为活跃度。

`updatedAt` 是 DSH 自己给会话列表排序用的那个时间：
`max(会话创建时间, 最后一次用户消息时间)`。也就是左侧每个会话行上显示的「刚刚 / 3 分钟前」。
所以工作区顺序和你眼睛看到的相对时间是同一套依据。

然后：

| 情况 | 处理 |
| --- | --- |
| 有会话 | 按最新活跃时间降序，最近的在最上 |
| 没有会话 | 默认按该工作区自身的创建时间参与排序（新建的空工作区会靠前，符合 DSH 原有习惯） |
| 时间完全相同 | 先按创建时间新的在前，再按原有顺序，保证结果稳定不抖动 |

子代理会话（`origin: 'subagent'`）默认**不参与**计算 —— 浏览器本来就不把它们渲染成行，
算进去只会让「你从没打过字的工作区」莫名跳到顶上。

## 触发时机

| 事件 | 含义 |
| --- | --- |
| `api-session/activity` | 某个会话里用户发了消息 |
| `api-session/added` / `removed` | 会话出现或消失 |
| `domain/changed`（workspace 域） | 工作区被创建/删除/改名 |
| 定时巡检（默认 5 分钟） | 兜底，事件漏了也能收敛 |
| 插件启动 | 装载后先排一次 |

所有触发都汇总到一个防抖窗口里（默认 400ms），一次事件风暴只重排一次。

重排是**幂等**的：算出来的顺序和当前一样就一个字节都不写。写入次数也是最小的 ——
单个工作区挪位置只花 **1 次**写；只有整体顺序真的翻了才会多次写。

## 安装

已经装进 `desktop` profile 了。要再装一次（或装到别的 profile）：

```bash
dsh plugin --profile <profile> add /绝对路径/dsh-workspace-recency-order
```

或者在这个 GUI 里用「设置 → 插件」的安装入口，spec 填上面那个绝对路径。
本包声明了 `dsh.bundle.patch`，安装时会被自动加进 profile 的 `dsh.profile.bundles`，
`cordis.patch.yml` 里插入一行 `workspace-recency-order`，不需要手改任何 profile 文件。

### 卸载

在「设置 → 插件」里把 `dsh-workspace-recency-order` 卸载，或者把 profile
`package.json` 的 `dsh.profile.bundles` 里那一项去掉。卸载后工作区**保持最后一次的顺序**，
不会回滚（顺序本来就是工作区的正常持久状态）。

### 暂停

两种都行：

- 「设置 → 插件」里把 `workspace-recency-order` 这一行停用；
- 或者在 profile 的 `cordis.patch.yml` 里给该行加 `config: {enabled: false}`。

## 配置

在 profile 的补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里按 **同一个 id 重述整行**。
补丁按行替换 `config`、不做深度合并，所以只写你想改的键，其余键由插件 schema 的默认值补齐：

```yaml
- id: workspace-recency-order
  name: 'dsh-workspace-recency-order'
  config:
    sweepMs: 0          # 关掉兜底巡检
    debounceMs: 1000    # 防抖放宽到 1 秒
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件保持加载但不排序 |
| `direction` | `'desc'` | `desc` = 最近活跃的在最上；`asc` = 最久未动的在最上 |
| `emptyWorkspace` | `'createdAt'` | 没有会话的工作区怎么放：`createdAt` 按自身创建时间参与排序 / `bottom` 固定沉底 / `top` 固定置顶。`bottom`、`top` 是绝对的，`direction` 反转也不会跟着翻 |
| `countSubagentSessions` | `false` | 子代理会话是否也算进活跃度 |
| `debounceMs` | `400` | 事件合并窗口（毫秒，0–60000） |
| `sweepMs` | `300000` | 兜底巡检间隔（毫秒，0 = 关闭） |
| `skipWhenSessionListEmpty` | `true` | 一个会话都读不到时放弃本轮，避免启动早期用不完整数据改写顺序 |

写错的键或类型会让插件行加载失败并报出具体是哪一项 —— 不会静默忽略你的配置。

> **关于「插件页看不到配置表单」**
>
> 本插件刻意不依赖 `@deepseek-ai/schemastery`（零运行时依赖，装在哪都能加载），
> 配置校验用的是同一套 Standard Schema 接口。代价是 DSH 的配置页无法把它投影成表单，
> 该项在 Config 巡检里显示为 `unsupported`。这是被正常处理的状态，不是报错；
> 改配置请按上面的方式编辑补丁层。

## 开发

零依赖，纯 ESM：

```bash
node --test test/     # 54 个测试
```

- `lib/order.js` —— 纯函数：活跃度投影、排序、以及把「顺序变化」翻译成最少的
  `insertBefore` 写入序列。
- `lib/index.js` —— 插件本体：事件接线、防抖、幂等重排、生命周期清理。
- `test/order.test.js` —— 含 4 个工作区全排列（24×24）与 6 个工作区随机打乱的
  **写入计划正确性**穷举校验：按计划顺序执行后必须**精确**得到目标顺序。
- `test/plugin.test.js` —— 对着一个忠实模拟 `insertBefore` 与 `domain/changed` 语义的
  假 Host 跑集成测试：触发、去重、空列表保护、不与自己的写入打架、销毁后不再动手。

改完代码保存即可 —— profile 里是 `link:` 安装，但**改了 `lib/` 需要重启 DSH**
（插件的模块不会被热重载；`cordis.patch.yml` 的改动才是 live 的）。

## 已知边界

- 顺序是**全局持久**的：它改的是 Host 的工作区注册表顺序，因此对该 profile 下所有客户端生效，
  不存在「只在我这台机器上这样排」。
- DSH 目前**没有**手动拖拽排序工作区的 UI，所以本插件不会和你的手动操作打架。
  将来如果官方加了拖拽，本插件会在下次触发时把顺序拉回活跃度序。
- 「最新会话时间」取的是**最后一次用户消息**，不是助手回复时间。助手在后台跑完不会让工作区跳位。
