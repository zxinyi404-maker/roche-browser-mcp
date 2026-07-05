# 浏览器 MCP（Roche 插件）

给 Roche 的 AI 装上真实的浏览器能力：**联网搜索 + 打开网页读正文**，并且能**挂载某个角色的人设与记忆，让联网结果和角色记忆互通**。AI 自己决定何时联网、搜什么、读哪一页，以挂载角色的身份回答，还能把新事实写回同一条会话记忆。

因为 Roche 是纯前端、浏览器有 CORS 限制，所有外部请求都通过你自建的 CORS 代理转发（就是压缩包里那份 `app.py`）。

## 到底能搜/能读什么？（老实说）

**能：**
- 搜索：DuckDuckGo 能搜到的公开网页，基本是「全网公开内容」——新闻、百科、博客、文档、论坛等。
- 读网页：任意公开 URL 的正文。普通网页用「直接抓取」;JS 渲染的单页应用（微博、部分新站等）切到 **Jina Reader** 模式能读到渲染后的正文。
- 读登录内容：在设置里配「站点鉴权」，把你的 Cookie / Authorization 头填给指定域名，AI 就能读**你已登录**的页面（你自己的后台、需要登录的文档站等）。

**不能 / 有限制：**
- 不是真浏览器，**不能点按钮、填表单、登录、翻页、跑复杂交互**——只能「取一个 URL 的内容」。
- 抓取受你代理的网络位置限制（HF 在海外），墙内站点/需特定地区的站点可能不通。
- DuckDuckGo 偶尔反爬;强验证码 / Cloudflare 盾的页面读不了。
- 违法内容、需要你没有的权限的内容，一样读不了。

一句话：**公开的、以及你自己能登录看到的，基本都能搜能读;需要「操作」而不只是「读取」的，做不到。**

## 记忆互通是怎么工作的

在设置里「挂载角色 / 会话」选一个单聊或群聊后，每次联网问答插件都会：

1. 读 `roche.persona.getActiveUserPersona()` 拿当前用户人设。
2. 读该会话：`roche.conversation.get()` + 单聊角色 `roche.character.get()`（拿人设）。
3. 读该会话长期记忆 `roche.memory.getLongTerm()`（core + facts）和最近消息 `roche.memory.getShortTerm()`。
4. 把这些拼成 system 上下文，AI 就以该角色身份、结合已有记忆来回答联网结果。
5. AI 觉得有值得长期记住的新事实时，会调用 `save_memory` 工具写回 `roche.memory.write()`；你也可以点底部「记忆」按钮把上一条回答手动写回，或在设置里开「自动写回」。

写回的是 **Roche 主事实记忆**，和你在正常聊天里积累的记忆是同一份，所以联网学到的东西下次在普通对话里角色也记得——这就是互通。

---

## 1. GitHub 文件结构

```txt
roche-browser-mcp/
  manifest.json      ← 安装时填这个的 Raw 链接
  plugin.js          ← 插件本体
  proxy/             ← CORS 代理（部署到 Hugging Face）
    app.py
    Dockerfile
    requirements.txt
```

## 2. 安装时填哪个链接

把仓库传到 GitHub 后，Roche 安装框里**只填 manifest 的 Raw 链接**：

```txt
https://raw.githubusercontent.com/用户名/仓库名/main/manifest.json
```

⚠️ 不要填 `github.com/.../blob/...` 这种网页链接。

安装前记得改 `manifest.json` 里的 `entry`，指向你自己的 `plugin.js` Raw 链接：

```json
"entry": "https://raw.githubusercontent.com/用户名/仓库名/main/plugin.js"
```

## 3. 新手安装步骤

**第一步：部署 CORS 代理（必做，否则搜不了网）**
1. 打开 Hugging Face，创建 `New Space`。
2. SDK 选 `Docker`，Visibility 选 `Public`。
3. 把 `proxy/` 里的三个文件（`app.py`、`Dockerfile`、`requirements.txt`）传上去。
4. 等构建完成。你的代理地址就是：
   `https://你的用户名-你的空间名.hf.space/proxy`

**第二步：传插件到 GitHub**
1. 新建一个仓库，把 `manifest.json` 和 `plugin.js` 传上去。
2. 改 `manifest.json` 的 `entry` 为你自己的 `plugin.js` Raw 链接。

**第三步：在 Roche 里安装**
1. Roche → 插件 → 安装，填 `manifest.json` 的 Raw 链接。
2. 确认风险提示后安装。桌面/Dock 里会出现「浏览器 MCP」App。

**第四步：填代理地址**
1. 打开「浏览器 MCP」App → 右上角「设置」。
2. 把第一步的代理地址（`.../proxy`）填进「CORS 代理地址」，保存。
3. 回去问一句需要联网的问题试试。

## 记忆曲线（模拟人类遗忘 + 重要度）

插件多了一个「记忆管理」App，给角色的每条长期记忆套上**艾宾浩斯遗忘曲线**，并且**像真人一样按重要程度决定忘得快不快**：

- 留存率 `R = e^(-t/S)`，`t` 是距上次回忆的天数，`S` 是记忆强度（天）。
- 每条记忆有**重要度 1~4**：琐事 / 一般 / 重要 / 刻骨铭心。越重要初始强度越高、遗忘越慢，而且有**强度下限**（floor），久不复习也不会瞬间归零。
- 不复习时的真实衰减（实测）：

  | 重要度 | 1天 | 3天 | 7天 | 14天 | 30天 | 90天 |
  |---|---|---|---|---|---|---|
  | 琐事 | 8%~ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | 一般 | 51% | 14%~ | ✗ | ✗ | ✗ | ✗ |
  | 重要 | 85% | 61% | 31% | 10%~ | ✗ | ✗ |
  | 刻骨铭心 | 97% | 90% | 79% | 63% | 37% | 5%~ |

  （✗=已遗忘，~=模糊，其余=还清晰记得。琐事聊完当天就忘，刻骨铭心的事能撑好几个月）

- 重要度谁来定？三条路：① AI 用 `save_memory` 写入时自己评估（prompt 里教了 1~4 的判断标准）;② 普通聊天里冒出来的记忆用**关键词启发式**猜（提到「去世/承诺/秘密」给高分，「今天天气/随便」给低分）;③ 你在「记忆管理」界面手动改。
- 每次记忆「被回忆到」或你点「复习」，强度按重要度增长（×1.5~×3）——**间隔重复效应**，越重要复习一次涨得越多。
- 聊天时插件只把**还记得（留存 ≥20%）**的塞进上下文;**模糊的**只给零碎提示，让 AI 表现出「有印象但记不太清」;**忘光的**不进上下文。
- 「钉住」永不遗忘（核心设定用）;「遗忘扫描」批量清理快忘光的（重要记忆因为有 floor 天然不会被扫走）。

记忆强度/重要度这些元数据存在插件自己的 `roche.storage` 影子档案里（按会话隔离），**不改 Roche 主记忆结构**;记忆正文和普通聊天共用同一份 Roche 主事实记忆，所以和角色记忆是互通的。

参数在 `plugin.js` 顶部常量可调：`IMPORTANCE_STRENGTH`（各级初始强度）、`IMPORTANCE_FLOOR`（各级遗忘下限）、`IMPORTANCE_REINFORCE`（复习系数）、`RECALL_THRESHOLD`（召回阈值）等。

## 4. 关键代码解释

- **手写 MCP 循环**（`runAgent`）：给 AI 一段系统提示，约定它要联网时就输出一个 JSON 动作块，比如 `{"action":"web_search","query":"..."}`。插件解析这个块 → 执行工具 → 把结果以「【工具结果】」塞回对话 → 再让 AI 继续，直到它输出 `{"action":"final"}` 开头的最终答案。最多 `maxSteps` 步（默认 5），防死循环。
- **三个工具**：`web_search`、`open_page`，外加 `save_memory`（AI 主动把重要结论写回角色记忆，带 importance 重要度）。
  - `toolWebSearch` 走 DuckDuckGo HTML 版，无需 API key，用 `DOMParser` 解析结果列表。
  - `toolOpenPage` 两种模式：**直接抓取**（本地抽正文，适合普通网页）或 **Jina Reader**（经 `r.jina.ai` 拿 JS 渲染后的正文，读得了 SPA 单页应用）;并支持**站点鉴权头**，读登录后的页面。
- **记忆曲线引擎**：`retention()` 算留存率，`reinforce()` 做复习强化，`syncMemories()` 把 Roche 主事实和插件影子档案对齐，`decayScan()` 找出该遗忘的。`buildContextBlock()` 按留存率过滤后再拼进上下文。
- **proxyFetch**：所有外链都 POST 到你的代理 `/proxy`，代理再转发，绕过 CORS。识别 `x-ai-proxy-error` 响应头来报错。
- **roche.ai.chat**：复用 Roche 当前的 AI 配置，不额外要 key。插件只负责拼 `messages`。

## 5. 数据存储方案

用 `roche.storage`（宿主 IndexedDB，按 `pluginId+appId+key` 隔离）保存：

| key | 内容 |
|---|---|
| `proxyUrl` | 你的 CORS 代理地址 |
| `searchProxyUrl` | 可选的搜索直通代理 |
| `maxSteps` | 最大工具调用步数 |
| `mountedConversationId` | 挂载的角色/会话 ID |
| `autoWrite` | 是否自动写回记忆 |
| `readerMode` | 读页模式 raw / jina |
| `siteAuth` | 登录站点的鉴权头（Cookie/Authorization） |
| `memMeta:<会话ID>` | 记忆曲线影子档案（强度/重要度/复习次数/钉住等） |

这些都是插件私有数据，**卸载插件时 Roche 会自动清理**，不碰主 IndexedDB 结构。

注意：记忆**正文**写在 Roche 主事实记忆里（通过 `roche.memory.write`），这份**不随插件卸载删除**；插件只在自己的 storage 里存记忆的「强度/时间」等元数据。「遗忘」和「遗忘扫描」会调用 `roche.memory.delete` 真正删除主记忆，不可恢复。

## 6. 风险提示和注意事项

- 这是**全信任 JS 插件**，运行在 Roche 页面环境里。只装你信得过来源的插件。
- **代理会看到请求内容**：你搜索的关键词、打开的网址都会经过你的 HF 代理。代理是你自己的 Space，别人填别人的地址。建议给 Space 设 `ALLOWED_PROXY_ORIGINS` 限制来源。
- **DuckDuckGo 可能反爬**：如果搜索反复失败，多半是被限流或代理不通，换个时间或检查代理。
- **JS 渲染页面**：默认「直接抓取」只拿初始 HTML、不执行 JS，SPA 可能读不到正文;这时切到 **Jina Reader** 模式（会把 URL 发给第三方 `r.jina.ai` 渲染，等于让 Jina 也看到你要读的网址，读登录页时还会把你的 Cookie 透传给 Jina——介意就别对敏感站点用 Jina）。
- **站点鉴权（登录内容）风险最高**：填进去的 Cookie / token 等于把该站点的登录态交给整条 AI 流程——它会随请求经你的代理发出，代理和（Jina 模式下）Jina 都可能看到。**只填你信任的普通站点，绝对别填银行、支付、主邮箱这类账号。** 凭证只存在你本地插件存储，卸载插件即清除。
- **AI 会消耗你的 tokens**：每轮工具调用都是一次 `roche.ai.chat`，联网问答比普通聊天更费额度。
- **写回记忆是主记忆**：`save_memory`、「记忆」按钮、自动写回都写进 Roche 主事实记忆，**不随插件卸载删除**;记忆元数据（强度/重要度）才是插件私有、会随卸载清理。
- 权限申请了 `persona:read`、`character:read`、`memory:read/write`、`ai:chat`、`storage`、`ui`。若你只想要纯浏览器工具、不用记忆互通，可在 manifest 里删掉前四项。
