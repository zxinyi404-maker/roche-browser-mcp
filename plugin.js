/*
 * 浏览器 MCP for Roche
 * -------------------------------------------------------------
 * 给 Roche 的 AI 装上两个真实工具：
 *   web_search(query)  联网搜索（DuckDuckGo HTML，无需 key）
 *   open_page(url)     打开网页并抽取正文
 *
 * 由于 Roche 是纯前端、浏览器有 CORS 限制，所有外部请求
 * 都通过用户自建的 CORS 代理（app.py 的 /proxy 端点）转发。
 *
 * 工作流：AI 用 roche.ai.chat 回答问题时，如果需要联网，
 * 就按约定输出一个 JSON 动作块；插件解析后执行工具，把结果
 * 塞回对话，再让 AI 继续，直到给出最终答案。（手写 MCP 循环）
 *
 * v1.3：奶油萌系换肤 + 长期挂载（设置双写 roche.storage & localStorage，
 *       退出后代理/挂载不再丢失）+ 移动端下滑滚动适配（safe-area / 惯性滚动）。
 */
(function () {
  "use strict";

  const PLUGIN_ID = "browser-mcp";
  const APP_ID = "browser-mcp-home";
  const STYLE_ID = "roche-plugin-browser-mcp-style";

  const MEM_APP_ID = "browser-mcp-memory";
  const KEY_PROXY = "proxyUrl";
  const KEY_SEARCH = "searchProxyUrl";
  const KEY_MAXSTEPS = "maxSteps";
  const KEY_CONVO = "mountedConversationId"; // 当前挂载的角色/会话
  const KEY_AUTOWRITE = "autoWrite"; // 是否自动把结论写回记忆
  const KEY_READER = "readerMode"; // 读页模式：raw | jina
  const KEY_SITEAUTH = "siteAuth"; // 站点鉴权：[{host, headerName, headerValue}]

  // localStorage 前缀：作为 roche.storage 的“长期挂载”兜底。
  // 有些宿主的 roche.storage 会在退出后被清掉，导致填过的代理/挂载丢失，
  // 所以所有设置都同时写一份到 localStorage（PWA 同源持久化），读时两边都看。
  const LS_PREFIX = "bmcp:";

  // ---- 记忆曲线参数（艾宾浩斯 R = e^(-t/S)）----
  const DAY_MS = 86400000;
  const RECALL_THRESHOLD = 0.2; // 留存率高于此值才算“还记得”，会进上下文
  const FORGET_THRESHOLD = 0.04; // 低于此值且够旧，视为彻底遗忘可清理
  const MAX_STRENGTH_DAYS = 3650; // 强度上限（约 10 年），核心记忆用
  // 重要度 → 初始强度（天）。1=琐事 2=一般 3=重要 4=刻骨铭心
  const IMPORTANCE_STRENGTH = { 1: 0.4, 2: 1.5, 3: 6, 4: 30 };
  // 重要度 → 强度下限（天）。像真人：越重要的记忆，遗忘曲线越平，
  // 就算很久没想起也不会彻底忘光。强度永远不会低于这个值。
  const IMPORTANCE_FLOOR = { 1: 0.3, 2: 1, 3: 5, 4: 20 };
  // 重要度 → 复习强化系数。重要的事复习一次记得更牢。
  const IMPORTANCE_REINFORCE = { 1: 1.5, 2: 1.9, 3: 2.4, 4: 3 };
  const IMPORTANCE_LABEL = { 1: "琐事", 2: "一般", 3: "重要", 4: "刻骨铭心" };

  // ---- 每个 App 实例自己的运行时状态，避免多次 mount 串味 ----
  function createState() {
    return {
      root: null,
      roche: null,
      proxyUrl: "",
      searchProxyUrl: "",
      maxSteps: 5,
      busy: false,
      abort: false,
      timers: [],
      // 记忆互通相关
      conversations: [], // roche.conversation.list() 结果
      mountedConvId: "", // 用户勾选挂载的会话 ID
      mountedConv: null, // 该会话的详细信息
      autoWrite: false, // 联网结论是否自动写回该会话记忆
      lastAnswer: "", // 最近一次最终回答，供“写入记忆”按钮使用
      // 抓取增强
      readerMode: "raw", // raw=直接抓HTML  jina=经 r.jina.ai 读JS渲染后的正文
      siteAuth: [], // [{host, headerName, headerValue}] 登录站点用的鉴权头
    };
  }

  // ------------------------------------------------------------
  // 持久化：长期挂载。roche.storage + localStorage 双写，读时兜底。
  // 解决“退出后代理/挂载设置丢失”——localStorage 在 PWA 同源下长期保留。
  // ------------------------------------------------------------
  function lsGet(key) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw == null) return undefined;
      return JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
    } catch (e) {}
  }
  function lsRemove(key) {
    try {
      localStorage.removeItem(LS_PREFIX + key);
    } catch (e) {}
  }

  // 读设置：优先宿主 storage，宿主没有再回退 localStorage（并顺手补写回宿主）
  async function storeGet(state, key) {
    let v;
    try {
      v = await state.roche.storage.get(key);
    } catch (e) {}
    if (v === undefined || v === null || v === "") {
      const ls = lsGet(key);
      if (ls !== undefined) {
        v = ls;
        // 宿主里没有就补回去，尽量让两边一致
        try {
          await state.roche.storage.set(key, ls);
        } catch (e) {}
      }
    }
    return v;
  }

  // 写设置：两边都写，确保退出后不丢
  async function storeSet(state, key, val) {
    try {
      await state.roche.storage.set(key, val);
    } catch (e) {}
    lsSet(key, val);
  }

  // ------------------------------------------------------------
  // 通用工具函数
  // ------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clampText(str, max) {
    str = String(str || "");
    if (str.length <= max) return str;
    return str.slice(0, max) + "\n...[已截断]";
  }

  // 通过 CORS 代理发起请求，返回 { status, text }
  async function proxyFetch(state, url, opts) {
    opts = opts || {};
    if (!state.proxyUrl) {
      throw new Error("尚未配置 CORS 代理地址，请先在设置里填写。");
    }
    const payload = {
      url: url,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };
    if (opts.body != null) payload.body = opts.body;

    const resp = await fetch(state.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (resp.headers.get("x-ai-proxy-error") === "true") {
      throw new Error("代理错误: " + clampText(text, 300));
    }
    return { status: resp.status, text: text };
  }

  // ------------------------------------------------------------
  // 工具 1：联网搜索（DuckDuckGo HTML 版，无需 API key）
  // ------------------------------------------------------------
  async function toolWebSearch(state, query) {
    query = String(query || "").trim();
    if (!query) return { ok: false, error: "空查询" };

    // 允许用户配置独立的搜索代理，否则复用通用代理
    const base = state.searchProxyUrl || null;
    const searchUrl =
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);

    let html;
    try {
      if (base) {
        // searchProxyUrl 是一个 GET 直通代理，形如 https://proxy/?url=
        const resp = await fetch(base + encodeURIComponent(searchUrl));
        html = await resp.text();
      } else {
        const r = await proxyFetch(state, searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        html = r.text;
      }
    } catch (e) {
      return { ok: false, error: "搜索请求失败: " + e.message };
    }

    const results = parseDuckResults(html).slice(0, 6);
    if (!results.length) {
      return { ok: false, error: "没有解析到搜索结果（可能被反爬或代理不通）" };
    }
    return { ok: true, results: results };
  }

  // 从 DuckDuckGo HTML 结果页里抽 标题/链接/摘要
  function parseDuckResults(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const out = [];
    const nodes = doc.querySelectorAll(".result__body, .web-result, .result");
    nodes.forEach(function (node) {
      const a =
        node.querySelector("a.result__a") ||
        node.querySelector(".result__title a") ||
        node.querySelector("a");
      if (!a) return;
      let href = a.getAttribute("href") || "";
      // DDG 会把真实链接包在 uddg 参数里
      const m = href.match(/[?&]uddg=([^&]+)/);
      if (m) {
        try {
          href = decodeURIComponent(m[1]);
        } catch (e) {}
      }
      const snip =
        node.querySelector(".result__snippet") ||
        node.querySelector(".result-snippet");
      const title = (a.textContent || "").trim();
      if (!title || !/^https?:\/\//.test(href)) return;
      out.push({
        title: title,
        url: href,
        snippet: (snip ? snip.textContent : "").trim(),
      });
    });
    return out;
  }

  // 找出某 URL 匹配的站点鉴权头（用于登录后才能看的页面）
  function authHeadersFor(state, url) {
    const headers = {};
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return headers;
    }
    (state.siteAuth || []).forEach(function (a) {
      if (!a || !a.host || !a.headerName) return;
      const h = a.host.trim().toLowerCase();
      if (host === h || host.endsWith("." + h)) {
        headers[a.headerName] = a.headerValue || "";
      }
    });
    return headers;
  }

  // ------------------------------------------------------------
  // 工具 2：打开网页并抽取正文
  // - readerMode=jina：经 r.jina.ai 拿“JS 渲染后 + 已转 Markdown”的正文，
  //   能读大部分 SPA 单页应用。
  // - siteAuth：给匹配的站点带上鉴权头（Cookie / Authorization），
  //   让 AI 能读需要登录的页面。
  // ------------------------------------------------------------
  async function toolOpenPage(state, url) {
    url = String(url || "").trim();
    if (!/^https?:\/\//.test(url)) {
      return { ok: false, error: "非法 URL（必须以 http/https 开头）" };
    }

    const authHeaders = authHeadersFor(state, url);
    const baseHeaders = Object.assign({ "User-Agent": "Mozilla/5.0" }, authHeaders);

    // Jina Reader 模式：直接拿渲染后的 Markdown 正文
    if (state.readerMode === "jina") {
      const jinaUrl = "https://r.jina.ai/" + url;
      const jinaHeaders = { "User-Agent": "Mozilla/5.0" };
      // 若该站点配了鉴权，用 X-Set-Cookie / X-Authorization 透传给 Jina
      if (authHeaders["Cookie"]) jinaHeaders["X-Set-Cookie"] = authHeaders["Cookie"];
      if (authHeaders["Authorization"])
        jinaHeaders["X-Authorization"] = authHeaders["Authorization"];
      try {
        const r = await proxyFetch(state, jinaUrl, { headers: jinaHeaders });
        const md = (r.text || "").trim();
        if (md) {
          // Jina 返回顶部通常有 "Title: xxx"
          const tm = md.match(/^Title:\s*(.+)$/m);
          return {
            ok: true,
            url: url,
            title: tm ? tm[1].trim() : "",
            text: clampText(md, 6000),
          };
        }
      } catch (e) {
        // Jina 失败则回退到直接抓取
      }
    }

    // 直接抓 HTML 再本地抽正文
    let html;
    try {
      const r = await proxyFetch(state, url, { headers: baseHeaders });
      html = r.text;
    } catch (e) {
      return { ok: false, error: "打开网页失败: " + e.message };
    }
    const extracted = extractReadable(html);
    return {
      ok: true,
      url: url,
      title: extracted.title,
      text: clampText(extracted.text, 6000),
    };
  }

  // 极简正文抽取：去掉脚本/样式/导航，取可见文本
  function extractReadable(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const title = (doc.querySelector("title") || {}).textContent || "";
    doc
      .querySelectorAll(
        "script,style,noscript,nav,header,footer,aside,svg,iframe,form"
      )
      .forEach(function (n) {
        n.remove();
      });
    // 优先 article / main
    const main =
      doc.querySelector("article") ||
      doc.querySelector("main") ||
      doc.body ||
      doc.documentElement;
    let text = (main ? main.textContent : "") || "";
    text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
    return { title: title.trim(), text: text };
  }

  // ------------------------------------------------------------
  // MCP 循环：让 AI 通过 JSON 动作块调用工具
  // ------------------------------------------------------------
  const SYSTEM_PROMPT = [
    "你是一个可以使用浏览器工具的助手，并且可能已挂载了某个角色的人设和记忆。",
    "如果下方提供了【角色人设】【长期记忆】，请以该角色的身份、口吻和已知记忆来回答，",
    "把联网查到的新信息和角色已有记忆结合起来，保持人设一致。",
    "",
    "你有三个工具：",
    '1) web_search —— 联网搜索，参数 { "query": "关键词" }',
    '2) open_page  —— 打开网页读取正文，参数 { "url": "https://..." }',
    '3) save_memory —— 把一条重要结论写回当前角色的长期记忆，',
    '   参数 { "text": "要记住的事实", "importance": 1~4 }',
    "",
    "关于 importance（重要度）——像真人一样决定这件事会不会被遗忘：",
    "  1 = 琐事/闲聊，很快就忘（天气、随口一提）",
    "  2 = 一般信息（默认）",
    "  3 = 重要（对方的偏好、关系、重要事件、身份）",
    "  4 = 刻骨铭心（生离死别、承诺、秘密、创伤，几乎一辈子记得）",
    "  重要度越高，记忆遗忘越慢、越难被清理。请如实评估，别什么都标 4。",
    "",
    "规则：",
    "- 当你需要实时信息、事实核查、或用户给了网址时，先调用 web_search / open_page。",
    "- 当你发现值得长期记住、且与当前角色相关的事实时，可调用 save_memory 写回记忆，",
    "  并给出合理的 importance。只写真正值得记的、简洁的一句话，不要把整段网页塞进记忆。",
    "- 每次只能调用一个工具，并且必须严格输出如下 JSON（不要有多余文字）：",
    '  {"action":"web_search","query":"..."}',
    '  或 {"action":"open_page","url":"https://..."}',
    '  或 {"action":"save_memory","text":"...","importance":3}',
    "- 工具结果会以 role=user、前缀【工具结果】的形式返回给你。",
    "- 你可以连续调用多个工具（先搜索、再打开某条结果、再决定是否记忆）。",
    "- 当信息足够时，直接输出给用户的最终回答，",
    '  并在开头加一行 {"action":"final"} 之后换行写正文。',
    "- 最终回答请用中文，符合角色口吻，并在末尾附上你参考过的链接。",
  ].join("\n");

  // 尝试从 AI 输出里解析动作
  function parseAction(text) {
    text = String(text || "").trim();
    // 找第一个 { ... } JSON
    const start = text.indexOf("{");
    if (start === -1) return { action: "final", final: text };
    // 逐字符找匹配的右括号
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return { action: "final", final: text };
    let obj;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      return { action: "final", final: text };
    }
    if (obj.action === "final") {
      return { action: "final", final: text.slice(end + 1).trim() || text };
    }
    if (obj.action === "web_search") {
      return { action: "web_search", query: obj.query || obj.q || "" };
    }
    if (obj.action === "open_page") {
      return { action: "open_page", url: obj.url || "" };
    }
    if (obj.action === "save_memory") {
      return {
        action: "save_memory",
        text: obj.text || obj.summary || "",
        importance: obj.importance || obj.imp || 2,
      };
    }
    return { action: "final", final: text };
  }

  async function runAgent(state, userQuery, onStep) {
    // 拼接角色人设 + 记忆上下文
    const contextBlock = await buildContextBlock(state);

    const convo = [{ role: "system", content: SYSTEM_PROMPT }];
    if (contextBlock) {
      convo.push({
        role: "system",
        content: "以下是当前挂载的角色人设与记忆：\n\n" + contextBlock,
      });
    }
    convo.push({ role: "user", content: userQuery });

    for (let step = 0; step < state.maxSteps; step++) {
      if (state.abort) throw new Error("已取消");

      const resp = await rocheChat(state, convo);
      const raw = resp && resp.text ? resp.text : "";
      const parsed = parseAction(raw);

      if (parsed.action === "final") {
        state.lastAnswer = parsed.final || raw;
        return state.lastAnswer;
      }

      // 记录 AI 决定调用工具这一步
      convo.push({ role: "assistant", content: raw });

      let toolResultText;
      if (parsed.action === "web_search") {
        onStep && onStep("search", parsed.query);
        const r = await toolWebSearch(state, parsed.query);
        toolResultText = r.ok
          ? "搜索「" +
            parsed.query +
            "」结果：\n" +
            r.results
              .map(function (x, i) {
                return (
                  i +
                  1 +
                  ". " +
                  x.title +
                  "\n   " +
                  x.url +
                  (x.snippet ? "\n   " + x.snippet : "")
                );
              })
              .join("\n")
          : "搜索失败：" + r.error;
      } else if (parsed.action === "open_page") {
        onStep && onStep("open", parsed.url);
        const r = await toolOpenPage(state, parsed.url);
        toolResultText = r.ok
          ? "网页《" + (r.title || parsed.url) + "》正文：\n" + r.text
          : "打开失败：" + r.error;
      } else if (parsed.action === "save_memory") {
        const impLabel = IMPORTANCE_LABEL[clampImp(parsed.importance)];
        onStep && onStep("memory", parsed.text + "（" + impLabel + "）");
        const ok = await writeMemory(state, parsed.text, parsed.importance);
        toolResultText = ok
          ? "已写入长期记忆（重要度：" + impLabel + "）：" + parsed.text
          : "写入记忆失败（可能未挂载会话）";
      } else {
        toolResultText = "未知动作";
      }

      convo.push({
        role: "user",
        content: "【工具结果】\n" + toolResultText,
      });
    }

    // 步数用尽，逼 AI 给出最终答案
    convo.push({
      role: "user",
      content: "工具调用次数已达上限，请基于已有信息直接给出最终中文回答。",
    });
    const last = await rocheChat(state, convo);
    state.lastAnswer = (last && last.text) || "（未能生成回答）";
    return state.lastAnswer;
  }

  // 封装 roche.ai.chat
  async function rocheChat(state, messages) {
    return await state.roche.ai.chat({
      messages: messages,
      temperature: 0.4,
    });
  }

  // ------------------------------------------------------------
  // 记忆互通：读取当前用户人设 + 挂载会话的角色/记忆，拼成上下文
  // ------------------------------------------------------------
  async function buildContextBlock(state) {
    const roche = state.roche;
    const parts = [];

    // 1) 当前用户人设
    try {
      const me = await roche.persona.getActiveUserPersona();
      if (me) {
        const myName = me.name || me.handle || "用户";
        const myPersona = me.persona || me.bio || "";
        parts.push(
          "【当前用户】" +
            myName +
            (myPersona ? "\n用户设定：" + clampText(myPersona, 800) : "")
        );
      }
    } catch (e) {}

    // 2) 挂载的会话（角色/群聊）人设 + 记忆
    if (state.mountedConvId) {
      try {
        const conv =
          state.mountedConv ||
          (await roche.conversation.get(state.mountedConvId));
        state.mountedConv = conv;

        const convName = conv ? conv.name || conv.title || conv.handle : "";
        if (convName) parts.push("【当前对话】" + convName);

        // 单聊：补角色人设
        if (conv && conv.contactId) {
          try {
            const char = await roche.character.get(conv.contactId);
            if (char) {
              const cname = char.name || char.handle || "角色";
              const cpersona = char.persona || char.bio || "";
              if (cpersona) {
                parts.push(
                  "【角色人设：" + cname + "】\n" + clampText(cpersona, 1200)
                );
              }
            }
          } catch (e) {}
        }

        // 群聊：补成员人设摘要
        if (conv && conv.isGroup && Array.isArray(conv.memberProfiles)) {
          const roster = conv.memberProfiles
            .map(function (m) {
              return (m.handle || m.name || m.displayName || "").trim();
            })
            .filter(Boolean)
            .join("、");
          if (roster) parts.push("【群聊成员】" + roster);
        }

        // 3) 该会话长期记忆——按记忆曲线过滤：只召回“还记得”的
        try {
          const mem = await roche.memory.getLongTerm({
            conversationId: state.mountedConvId,
            limit: 200,
          });
          const coreText =
            (mem && mem.core && (mem.core.summary || mem.core.text)) || "";

          // 同步影子档案，拿到每条事实的记忆强度
          const synced = await syncMemories(state, state.mountedConvId);
          const meta = synced.meta;
          const facts = (mem && mem.facts) || [];
          const now = Date.now();

          const recalled = []; // 进上下文的（还记得）
          const faded = []; // 模糊的（低留存，给个模糊提示）
          const reinforceIds = [];

          facts.forEach(function (f) {
            const id = memIdOf(f);
            const m = meta[id];
            const r = m ? retention(m, now) : 1;
            const t = factText(f);
            if (!t) return;
            if (r >= RECALL_THRESHOLD) {
              recalled.push({ t: t, r: r });
              reinforceIds.push(id); // 被成功回忆 → 之后强化
            } else {
              faded.push(t);
            }
          });

          // 被回忆到的记忆强度增长并刷新时间（间隔重复）
          if (reinforceIds.length) {
            reinforceIds.forEach(function (id) {
              if (meta[id]) reinforce(meta[id]);
            });
            await saveMeta(state, state.mountedConvId, meta);
          }

          const vectorText = ((mem && mem.vectors) || [])
            .map(function (v) {
              return v.summaryText || v.action || v.text || "";
            })
            .filter(Boolean)
            .join("\n");

          const clearText = recalled
            .sort(function (a, b) {
              return b.r - a.r;
            })
            .map(function (x) {
              return x.t;
            })
            .join("\n");

          const memText = [coreText, clearText, vectorText]
            .filter(Boolean)
            .join("\n");
          if (memText) {
            parts.push("【清晰的长期记忆】\n" + clampText(memText, 2000));
          }
          // 模糊记忆：只给数量和零碎提示，模拟“想不太起来”
          if (faded.length) {
            const hint = faded
              .slice(0, 5)
              .map(function (t) {
                return "· " + clampText(t, 24);
              })
              .join("\n");
            parts.push(
              "【模糊记忆】（有些印象但记不太清，如被问到可以含糊或说记不清了）\n" +
                hint
            );
          }
        } catch (e) {}

        // 4) 最近消息（短期记忆），给 AI 一点当下语境
        try {
          const msgs = await roche.memory.getShortTerm({
            conversationId: state.mountedConvId,
            limit: 20,
          });
          const recent = (msgs || [])
            .map(function (m) {
              const who = m.senderHandle || m.senderName || "";
              const t = m.text || "";
              return t ? (who ? who + "：" : "") + t : "";
            })
            .filter(Boolean)
            .join("\n");
          if (recent) {
            parts.push("【最近对话】\n" + clampText(recent, 1500));
          }
        } catch (e) {}
      } catch (e) {}
    }

    return parts.join("\n\n");
  }

  // 把一条结论写回挂载会话的 Roche 主事实记忆，并按重要度登记影子档案
  async function writeMemory(state, summaryText, importance) {
    if (!state.mountedConvId) {
      state.roche.ui.toast("请先在设置里挂载一个角色/会话");
      return false;
    }
    summaryText = clampText(String(summaryText || "").trim(), 500);
    if (!summaryText) return false;
    const imp = clampImp(importance || guessImportance(summaryText));
    try {
      await state.roche.memory.write({
        conversationId: state.mountedConvId,
        summaryText: summaryText,
        action: summaryText,
        when: new Date().toLocaleString(),
        where: "浏览器 MCP 联网",
        source: "plugin:browser-mcp",
      });
      // 立即在影子档案里按重要度登记，让曲线从写入这刻起算
      try {
        const meta = await loadMeta(state, state.mountedConvId);
        const id = memIdOf({ summaryText: summaryText });
        const now = Date.now();
        meta[id] = meta[id] || {
          first: now,
          recall: 0,
          pinned: false,
        };
        meta[id].imp = imp;
        meta[id].s = Math.max(meta[id].s || 0, IMPORTANCE_STRENGTH[imp]);
        meta[id].last = now;
        meta[id].text = clampText(summaryText, 200);
        await saveMeta(state, state.mountedConvId, meta);
      } catch (e) {}
      return true;
    } catch (e) {
      state.roche.ui.toast("写入记忆失败：" + (e && e.message ? e.message : e));
      return false;
    }
  }

  // ============================================================
  // 记忆曲线引擎（模拟人类遗忘/复习）
  // ------------------------------------------------------------
  // Roche 主记忆本身没有“强度/时间”字段，所以插件在自己的
  // roche.storage 里维护一份“影子档案”，按会话隔离：
  //   memMeta:<convId> -> { [memId]: {s, imp, first, last, recall, pinned, text} }
  //   s      记忆强度 S（天），决定遗忘快慢
  //   imp    重要度 1~4，影响初始强度、遗忘下限、复习强化系数
  //   first  首次出现时间戳
  //   last   最近一次复习/被回忆的时间戳
  //   recall 被回忆次数
  //   pinned 是否钉住（永不遗忘）
  //   text   摘要快照，方便管理界面显示
  //
  // 重要度像真人：越重要的记忆遗忘越慢（初始强度高），而且强度有下限
  // （IMPORTANCE_FLOOR），再久不复习也不会归零——刻骨铭心的事一辈子记得。
  // ============================================================

  function clampImp(imp) {
    imp = parseInt(imp, 10);
    if (isNaN(imp) || imp < 1) return 2;
    if (imp > 4) return 4;
    return imp;
  }

  function metaKey(convId) {
    return "memMeta:" + (convId || "_global");
  }

  // 用文本生成稳定 id（Roche 事实若自带 id 优先用它）
  function memIdOf(fact) {
    if (fact && fact.id) return String(fact.id);
    const t = (fact && (fact.summaryText || fact.action || fact.text)) || "";
    let h = 0;
    for (let i = 0; i < t.length; i++) {
      h = (h * 31 + t.charCodeAt(i)) | 0;
    }
    return "h" + (h >>> 0).toString(36);
  }

  function factText(fact) {
    return (fact && (fact.summaryText || fact.action || fact.text)) || "";
  }

  // 艾宾浩斯留存率 R = e^(-t/S)，t、S 单位为天
  // 重要记忆有强度下限（floor），使其遗忘曲线更平、不会彻底忘光。
  function retention(meta, now) {
    if (meta.pinned) return 1;
    const ageDays = (now - (meta.last || meta.first || now)) / DAY_MS;
    const imp = clampImp(meta.imp);
    const floor = IMPORTANCE_FLOOR[imp] || 0.3;
    const s = Math.max(meta.s || 0.5, floor, 0.01);
    return Math.exp(-ageDays / s);
  }

  async function loadMeta(state, convId) {
    try {
      return (await state.roche.storage.get(metaKey(convId))) || {};
    } catch (e) {
      return {};
    }
  }

  async function saveMeta(state, convId, meta) {
    try {
      await state.roche.storage.set(metaKey(convId), meta);
    } catch (e) {}
  }

  // 把某会话的 Roche 事实记忆和影子档案同步：新事实登记，消失的清理
  async function syncMemories(state, convId) {
    if (!convId) return { meta: {}, facts: [] };
    const meta = await loadMeta(state, convId);
    let facts = [];
    try {
      const mem = await state.roche.memory.getLongTerm({
        conversationId: convId,
        limit: 200,
      });
      facts = (mem && mem.facts) || [];
    } catch (e) {}

    const now = Date.now();
    const seen = {};
    facts.forEach(function (f) {
      const id = memIdOf(f);
      seen[id] = true;
      if (!meta[id]) {
        // 新记忆：用关键词启发式猜重要度（AI 主动写入时会带更准的重要度）
        const t = factText(f);
        const imp = guessImportance(t);
        meta[id] = {
          s: IMPORTANCE_STRENGTH[imp],
          imp: imp,
          first: now,
          last: now,
          recall: 0,
          pinned: false,
          text: clampText(t, 200),
          rocheId: f.id || null,
        };
      } else {
        // 更新文本快照
        meta[id].text = clampText(factText(f), 200);
        if (f.id) meta[id].rocheId = f.id;
      }
    });

    // 影子档案里、但主记忆已不存在的条目：删掉影子
    Object.keys(meta).forEach(function (id) {
      if (!seen[id]) delete meta[id];
    });

    await saveMeta(state, convId, meta);
    return { meta: meta, facts: facts };
  }

  // 复习/被回忆：强度增长（间隔重复效应），刷新时间
  // 强化系数按重要度不同——重要的事复习一次记得更牢。
  function reinforce(meta) {
    const now = Date.now();
    const imp = clampImp(meta.imp);
    const factor = IMPORTANCE_REINFORCE[imp] || 1.9;
    meta.recall = (meta.recall || 0) + 1;
    meta.s = Math.min((meta.s || 0.5) * factor, MAX_STRENGTH_DAYS);
    meta.last = now;
    return meta;
  }

  // 修改重要度：同步调整初始强度基准（不倒退已积累的强度）
  function setImportance(meta, imp) {
    imp = clampImp(imp);
    meta.imp = imp;
    // 若当前强度比该重要度的初始值还低，抬到初始值（重估变重要=记得更清）
    meta.s = Math.max(meta.s || 0, IMPORTANCE_STRENGTH[imp]);
    return meta;
  }

  // 关键词启发式：给新记忆猜一个重要度，AISave 时会被 AI 的判断覆盖
  function guessImportance(text) {
    text = String(text || "");
    // 刻骨铭心：生离死别、承诺、创伤、身份核心
    if (/死|去世|离世|分手|告白|结婚|承诺|发誓|秘密|最爱|永远|再也不|背叛|遗言|出生|生日/.test(text))
      return 4;
    // 重要：关系、偏好、重要事件
    if (/喜欢|讨厌|害怕|梦想|目标|重要|第一次|名字叫|职业|工作是|住在|家人|朋友|计划/.test(text))
      return 3;
    // 琐事：临时、天气、闲聊
    if (/今天天气|随便|好像|也许|路过|顺便|无聊|随手/.test(text)) return 1;
    return 2;
  }

  // 遗忘扫描：返回可清理（留存率极低且够旧）的条目 id 列表
  // 重要记忆有 floor，retention 不会跌破 FORGET_THRESHOLD，天然不会被扫走。
  function decayScan(meta, now) {
    const dead = [];
    Object.keys(meta).forEach(function (id) {
      const m = meta[id];
      if (m.pinned) return;
      const ageDays = (now - (m.last || m.first || now)) / DAY_MS;
      const s = m.s || 0.5;
      if (retention(m, now) < FORGET_THRESHOLD && ageDays > s * 3) {
        dead.push(id);
      }
    });
    return dead;
  }

  // ------------------------------------------------------------
  // 样式
  // ------------------------------------------------------------
  const CSS = `
.roche-plugin-browser-mcp{
  --bm-cream:#fff8f2; --bm-cream2:#ffeef3; --bm-card:#fffdfb;
  --bm-pink:#ff9fb8; --bm-pink-d:#ff7fa0; --bm-peach:#ffd9c2;
  --bm-ink:#6f5d58; --bm-ink-soft:#a08e88; --bm-line:rgba(255,150,175,.22);
  display:flex;flex-direction:column;height:100%;min-height:0;
  font-family:"PingFang SC","Hiragino Sans GB",system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--bm-ink);
  background:linear-gradient(160deg,var(--bm-cream) 0%,var(--bm-cream2) 100%);
  box-sizing:border-box;-webkit-tap-highlight-color:transparent;
}
.roche-plugin-browser-mcp *{box-sizing:border-box}
.roche-plugin-browser-mcp .bmcp-bar{
  display:flex;align-items:center;gap:8px;
  padding:calc(12px + env(safe-area-inset-top)) 16px 12px;flex:0 0 auto;
  background:linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,.25));
  border-bottom:1px solid var(--bm-line);backdrop-filter:blur(6px);
}
.roche-plugin-browser-mcp .bmcp-bar h1{
  font-size:17px;margin:0;font-weight:700;flex:1;letter-spacing:.5px;
  color:var(--bm-pink-d);
}
.roche-plugin-browser-mcp .bmcp-bar h1::before{content:"🌸 "}
.roche-plugin-browser-mcp button{
  border:none;border-radius:999px;padding:8px 15px;font-size:13px;cursor:pointer;
  background:#fff;color:var(--bm-pink-d);font-weight:600;
  box-shadow:0 2px 8px rgba(255,150,175,.18);transition:transform .12s,box-shadow .12s,background .15s;
}
.roche-plugin-browser-mcp button:hover{background:#fff5f8;transform:translateY(-1px)}
.roche-plugin-browser-mcp button:active{transform:scale(.95)}
.roche-plugin-browser-mcp button.primary{
  background:linear-gradient(135deg,var(--bm-pink) 0%,var(--bm-pink-d) 100%);
  color:#fff;box-shadow:0 4px 14px rgba(255,127,160,.4);
}
.roche-plugin-browser-mcp button.primary:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
.roche-plugin-browser-mcp .bmcp-body{
  flex:1;min-height:0;overflow-y:auto;padding:16px;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
.roche-plugin-browser-mcp .bmcp-msg{
  margin-bottom:12px;padding:11px 14px;border-radius:18px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;font-size:14px;max-width:88%;
  box-shadow:0 2px 10px rgba(180,140,150,.1);
}
.roche-plugin-browser-mcp .bmcp-msg.user{
  background:linear-gradient(135deg,var(--bm-pink) 0%,var(--bm-pink-d) 100%);
  color:#fff;margin-left:auto;border-bottom-right-radius:6px;
}
.roche-plugin-browser-mcp .bmcp-msg.ai{
  background:var(--bm-card);border:1px solid var(--bm-line);
  border-bottom-left-radius:6px;
}
.roche-plugin-browser-mcp .bmcp-msg.tool{
  background:rgba(255,225,235,.55);font-size:12px;color:var(--bm-pink-d);
  border:1px dashed var(--bm-pink);border-radius:14px;max-width:100%;
}
.roche-plugin-browser-mcp .bmcp-msg a{color:var(--bm-pink-d);font-weight:600}
.roche-plugin-browser-mcp .bmcp-foot{
  flex:0 0 auto;padding:10px 12px calc(10px + env(safe-area-inset-bottom));
  border-top:1px solid var(--bm-line);
  display:flex;gap:8px;align-items:flex-end;
  background:linear-gradient(0deg,rgba(255,255,255,.7),rgba(255,255,255,.2));
}
.roche-plugin-browser-mcp textarea{
  flex:1;resize:none;border-radius:18px;border:1.5px solid var(--bm-line);
  background:#fff;color:var(--bm-ink);padding:11px 14px;font-size:14px;
  font-family:inherit;min-height:44px;max-height:120px;
  transition:border-color .15s,box-shadow .15s;
}
.roche-plugin-browser-mcp textarea:focus{
  outline:none;border-color:var(--bm-pink);box-shadow:0 0 0 3px rgba(255,159,184,.2);
}
.roche-plugin-browser-mcp .bmcp-settings textarea{
  width:100%;max-height:none;font-size:12px;font-family:ui-monospace,monospace;
  line-height:1.5;
}
.roche-plugin-browser-mcp .bmcp-settings{
  padding:16px;display:none;border-bottom:1px solid var(--bm-line);
  background:rgba(255,255,255,.5);overflow-y:auto;
  -webkit-overflow-scrolling:touch;
}
.roche-plugin-browser-mcp .bmcp-settings.show{display:block}
.roche-plugin-browser-mcp .bmcp-settings label{
  display:block;font-size:12px;color:var(--bm-ink-soft);font-weight:600;margin:12px 0 5px;
}
.roche-plugin-browser-mcp .bmcp-settings input,
.roche-plugin-browser-mcp .bmcp-settings select{
  width:100%;border-radius:12px;border:1.5px solid var(--bm-line);
  background:#fff;color:var(--bm-ink);padding:10px 12px;font-size:13px;
  transition:border-color .15s,box-shadow .15s;
}
.roche-plugin-browser-mcp .bmcp-settings input:focus,
.roche-plugin-browser-mcp .bmcp-settings select:focus,
.roche-plugin-browser-mcp .bmcp-settings textarea:focus{
  outline:none;border-color:var(--bm-pink);box-shadow:0 0 0 3px rgba(255,159,184,.2);
}
.roche-plugin-browser-mcp .bmcp-settings select option{background:#fff;color:var(--bm-ink)}
.roche-plugin-browser-mcp .bmcp-check{
  display:flex;align-items:center;gap:8px;font-size:13px;color:var(--bm-ink);margin-top:12px;
}
.roche-plugin-browser-mcp .bmcp-check input{width:auto;margin:0;accent-color:var(--bm-pink-d)}
.roche-plugin-browser-mcp .bmcp-hr{border:none;border-top:1px dashed var(--bm-line);margin:18px 0}
.roche-plugin-browser-mcp .bmcp-hint{font-size:12px;color:var(--bm-ink-soft);opacity:.85;margin-top:6px;line-height:1.6}
.roche-plugin-browser-mcp .bmcp-empty{
  color:var(--bm-ink-soft);text-align:center;margin-top:48px;font-size:14px;line-height:1.9;
}
.roche-plugin-browser-mcp .bmcp-empty::before{content:"🐰\A";white-space:pre;font-size:36px}

/* 记忆管理 App */
.roche-plugin-browser-mcp .bmem-topbar{
  display:flex;gap:8px;align-items:center;padding:12px 16px;
  border-bottom:1px solid var(--bm-line);flex:0 0 auto;flex-wrap:wrap;
  background:rgba(255,255,255,.5);
}
.roche-plugin-browser-mcp .bmem-topbar select{
  flex:1;min-width:140px;border-radius:12px;border:1.5px solid var(--bm-line);
  background:#fff;color:var(--bm-ink);padding:9px 12px;font-size:13px;
}
.roche-plugin-browser-mcp .bmem-topbar select option{background:#fff;color:var(--bm-ink)}
.roche-plugin-browser-mcp .bmem-stat{
  padding:10px 16px;font-size:12px;color:var(--bm-ink-soft);flex:0 0 auto;
  border-bottom:1px solid var(--bm-line);background:rgba(255,255,255,.3);
}
.roche-plugin-browser-mcp .bmem-list{
  flex:1;min-height:0;overflow-y:auto;padding:12px 16px;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
.roche-plugin-browser-mcp .bmem-item{
  border:1px solid var(--bm-line);border-radius:16px;padding:13px 14px;
  margin-bottom:12px;background:var(--bm-card);
  box-shadow:0 2px 10px rgba(180,140,150,.08);
}
.roche-plugin-browser-mcp .bmem-item .txt{font-size:14px;line-height:1.6;margin-bottom:10px;word-break:break-word}
.roche-plugin-browser-mcp .bmem-meter{
  height:8px;border-radius:99px;background:rgba(255,159,184,.15);overflow:hidden;margin-bottom:10px;
}
.roche-plugin-browser-mcp .bmem-meter i{display:block;height:100%;border-radius:99px;transition:width .4s ease}
.roche-plugin-browser-mcp .bmem-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--bm-ink-soft)}
.roche-plugin-browser-mcp .bmem-row .grow{flex:1}
.roche-plugin-browser-mcp .bmem-item button{padding:6px 11px;font-size:12px;border-radius:99px}
.roche-plugin-browser-mcp .bmem-pill{
  font-size:11px;padding:3px 9px;border-radius:99px;background:rgba(255,159,184,.15);
  color:var(--bm-pink-d);font-weight:600;
}
.roche-plugin-browser-mcp .bmem-pill.pinned{background:rgba(255,190,90,.25);color:#e59500}
.roche-plugin-browser-mcp .bmem-pill.imp1{background:rgba(180,170,165,.22);color:#9a8d88}
.roche-plugin-browser-mcp .bmem-pill.imp2{background:rgba(140,190,230,.22);color:#4d94c9}
.roche-plugin-browser-mcp .bmem-pill.imp3{background:rgba(255,180,110,.25);color:#e08a2e}
.roche-plugin-browser-mcp .bmem-pill.imp4{background:rgba(255,130,160,.25);color:#e0567f}
.roche-plugin-browser-mcp .bmem-imp{
  border-radius:10px;border:1.5px solid var(--bm-line);
  background:#fff;color:var(--bm-ink);font-size:12px;padding:5px 8px;
}
.roche-plugin-browser-mcp .bmem-imp option{background:#fff;color:var(--bm-ink)}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // ------------------------------------------------------------
  // UI 渲染
  // ------------------------------------------------------------
  function buildUI(state, container) {
    container.innerHTML =
      '<div class="roche-plugin-browser-mcp">' +
      '  <div class="bmcp-bar">' +
      '    <button class="bmcp-back">返回</button>' +
      "    <h1>浏览器 MCP</h1>" +
      '    <button class="bmcp-settings-btn">设置</button>' +
      "  </div>" +
      '  <div class="bmcp-settings">' +
      "    <label>挂载角色 / 会话（记忆互通）</label>" +
      '    <select class="bmcp-conv"><option value="">不挂载（纯浏览器工具）</option></select>' +
      '    <label class="bmcp-check"><input type="checkbox" class="bmcp-autowrite" /> 允许 AI 自动把重要结论写回该角色记忆</label>' +
      '    <div class="bmcp-hint">挂载后，联网问答会带上该角色的人设、长期记忆和最近对话，AI 以角色身份回答，并可把新事实写回同一条会话记忆，实现互通。</div>' +
      '    <hr class="bmcp-hr" />' +
      "    <label>CORS 代理地址（POST /proxy，必填）</label>" +
      '    <input class="bmcp-proxy" placeholder="https://你的空间.hf.space/proxy" />' +
      "    <label>搜索直通代理（可选，GET ?url= 形式，留空则走上面的代理）</label>" +
      '    <input class="bmcp-search" placeholder="留空即可" />' +
      "    <label>最大工具调用步数</label>" +
      '    <input class="bmcp-steps" type="number" min="1" max="10" />' +
      '    <div class="bmcp-hint">代理用于绕过浏览器 CORS。可用附带的 app.py 部署到 Hugging Face Space（Docker）。搜索基于 DuckDuckGo，无需 API key。</div>' +
      '    <hr class="bmcp-hr" />' +
      "    <label>读页模式</label>" +
      '    <select class="bmcp-reader">' +
      '      <option value="raw">直接抓取（快，适合普通网页）</option>' +
      '      <option value="jina">Jina Reader（读 JS 渲染的单页应用/动态站点）</option>' +
      "    </select>" +
      '    <div class="bmcp-hint">选 Jina Reader 时，打开网页会经 r.jina.ai 拿“渲染并转成正文”的结果，能读大部分 SPA。免费、无需 key。</div>' +
      '    <label>登录站点鉴权（每行一条：域名 | 头名 | 头值）</label>' +
      '    <textarea class="bmcp-siteauth" rows="3" placeholder="例：\nexample.com | Cookie | session=abc123\napi.foo.com | Authorization | Bearer sk-xxx"></textarea>' +
      '    <div class="bmcp-hint">给需要登录才能看的站点带上你的 Cookie 或 Authorization 头，AI 就能读登录后的内容。凭证只存在你本地插件存储，随请求经你自己的代理发出。⚠️ 等于把该站点的登录态交给 AI 流程，只填你信任的站点，别填银行/支付类。</div>' +
      '    <div style="margin-top:12px"><button class="bmcp-save primary">保存设置</button></div>' +
      "  </div>" +
      '  <div class="bmcp-body"></div>' +
      '  <div class="bmcp-foot">' +
      '    <textarea class="bmcp-input" placeholder="问点需要联网的问题，或直接贴网址让我读…"></textarea>' +
      '    <button class="bmcp-remember" title="把上一条回答写回当前角色记忆">记忆</button>' +
      '    <button class="bmcp-send primary">发送</button>' +
      "  </div>" +
      "</div>";

    const q = function (sel) {
      return container.querySelector(sel);
    };
    state.root = container.firstElementChild;

    const settingsPane = q(".bmcp-settings");
    const proxyInput = q(".bmcp-proxy");
    const searchInput = q(".bmcp-search");
    const stepsInput = q(".bmcp-steps");
    const convSelect = q(".bmcp-conv");
    const autoWriteBox = q(".bmcp-autowrite");
    const readerSelect = q(".bmcp-reader");
    const siteAuthArea = q(".bmcp-siteauth");
    const rememberBtn = q(".bmcp-remember");
    const body = q(".bmcp-body");
    const input = q(".bmcp-input");
    const sendBtn = q(".bmcp-send");

    proxyInput.value = state.proxyUrl;
    searchInput.value = state.searchProxyUrl;
    stepsInput.value = state.maxSteps;
    autoWriteBox.checked = !!state.autoWrite;
    readerSelect.value = state.readerMode || "raw";
    siteAuthArea.value = serializeSiteAuth(state.siteAuth);

    // 填充会话下拉列表
    function fillConversations() {
      // 先清掉除第一项外的旧选项
      while (convSelect.options.length > 1) convSelect.remove(1);
      (state.conversations || []).forEach(function (c) {
        const id = c.id || c.conversationId;
        if (!id) return;
        const label =
          (c.isGroup ? "👥 " : "💬 ") +
          (c.name || c.title || c.handle || id) +
          (c.isGroup ? "（群聊）" : "");
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = label;
        convSelect.appendChild(opt);
      });
      convSelect.value = state.mountedConvId || "";
    }
    fillConversations();

    // 返回
    q(".bmcp-back").onclick = function () {
      state.roche.ui.closeApp();
    };

    // 打开/关闭设置
    q(".bmcp-settings-btn").onclick = function () {
      settingsPane.classList.toggle("show");
    };

    // 保存设置
    q(".bmcp-save").onclick = async function () {
      state.proxyUrl = proxyInput.value.trim();
      state.searchProxyUrl = searchInput.value.trim();
      let n = parseInt(stepsInput.value, 10);
      if (isNaN(n) || n < 1) n = 5;
      if (n > 10) n = 10;
      state.maxSteps = n;

      // 挂载会话变化时，清掉缓存的会话详情
      const newConv = convSelect.value || "";
      if (newConv !== state.mountedConvId) {
        state.mountedConvId = newConv;
        state.mountedConv = null;
      }
      state.autoWrite = !!autoWriteBox.checked;
      state.readerMode = readerSelect.value === "jina" ? "jina" : "raw";
      state.siteAuth = parseSiteAuth(siteAuthArea.value);

      await storeSet(state, KEY_PROXY, state.proxyUrl);
      await storeSet(state, KEY_SEARCH, state.searchProxyUrl);
      await storeSet(state, KEY_MAXSTEPS, state.maxSteps);
      await storeSet(state, KEY_CONVO, state.mountedConvId);
      await storeSet(state, KEY_AUTOWRITE, state.autoWrite);
      await storeSet(state, KEY_READER, state.readerMode);
      await storeSet(state, KEY_SITEAUTH, state.siteAuth);
      updateRememberBtn();
      state.roche.ui.toast("设置已长期保存（退出也不会丢）");
      settingsPane.classList.remove("show");
    };

    // “记忆”按钮：把上一条回答写回当前角色记忆
    function updateRememberBtn() {
      rememberBtn.style.display = state.mountedConvId ? "" : "none";
    }
    updateRememberBtn();

    rememberBtn.onclick = async function () {
      if (!state.lastAnswer) {
        state.roche.ui.toast("还没有可写入的回答");
        return;
      }
      const ok = await state.roche.ui.confirm({
        title: "写入角色记忆",
        message:
          "确定把上一条回答作为一条长期记忆写入当前角色吗？\n（写入 Roche 主记忆，不随插件卸载删除）",
      });
      if (!ok) return;
      const done = await writeMemory(state, state.lastAnswer);
      if (done) {
        state.roche.ui.toast("已写入角色记忆");
        addMsg("tool", "📝 已把上一条回答写回角色长期记忆");
      }
    };

    // 渲染一条消息
    function addMsg(role, text) {
      const div = document.createElement("div");
      div.className = "bmcp-msg " + role;
      // AI/工具消息里把裸链接变成可点击
      div.innerHTML = linkify(escapeHtml(text));
      body.appendChild(div);
      body.scrollTop = body.scrollHeight;
      return div;
    }

    function refreshEmpty() {
      if (!body.children.length) {
        body.innerHTML =
          '<div class="bmcp-empty">还没有对话。<br>试试「帮我查一下今天的科技新闻」。</div>';
      }
    }
    refreshEmpty();

    async function doSend() {
      const text = input.value.trim();
      if (!text) return;
      if (state.busy) return;
      if (!state.proxyUrl) {
        state.roche.ui.toast("请先在设置里填写 CORS 代理地址");
        settingsPane.classList.add("show");
        return;
      }
      const empty = body.querySelector(".bmcp-empty");
      if (empty) empty.remove();

      input.value = "";
      state.busy = true;
      state.abort = false;
      sendBtn.disabled = true;
      sendBtn.textContent = "…";

      addMsg("user", text);

      try {
        const answer = await runAgent(state, text, function (kind, arg) {
          const prefix =
            kind === "search"
              ? "🔍 搜索："
              : kind === "open"
              ? "🌐 打开："
              : "📝 记忆：";
          addMsg("tool", prefix + arg);
        });
        addMsg("ai", answer);

        // 若开启自动写回，且挂载了会话，则静默存一条摘要
        if (state.autoWrite && state.mountedConvId && answer) {
          const saved = await writeMemory(state, answer);
          if (saved) addMsg("tool", "📝 已自动写回角色长期记忆");
        }
      } catch (e) {
        addMsg("ai", "出错了：" + (e && e.message ? e.message : e));
      } finally {
        state.busy = false;
        sendBtn.disabled = false;
        sendBtn.textContent = "发送";
      }
    }

    sendBtn.onclick = doSend;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSend();
      }
    });
  }

  function linkify(html) {
    return html.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );
  }

  // 站点鉴权文本 <-> 数组： "域名 | 头名 | 头值" 每行一条
  function parseSiteAuth(text) {
    return String(text || "")
      .split("\n")
      .map(function (line) {
        const p = line.split("|").map(function (x) {
          return x.trim();
        });
        if (p.length < 3 || !p[0] || !p[1]) return null;
        return {
          host: p[0],
          headerName: p[1],
          headerValue: p.slice(2).join("|").trim(),
        };
      })
      .filter(Boolean);
  }

  function serializeSiteAuth(arr) {
    return (arr || [])
      .map(function (a) {
        return [a.host, a.headerName, a.headerValue].join(" | ");
      })
      .join("\n");
  }

  // ------------------------------------------------------------
  // 记忆管理 App 的 UI
  // ------------------------------------------------------------
  function retentionColor(r) {
    // 薄荷绿 → 蜜桃黄 → 樱花粉（配合奶油萌系配色）
    if (r >= 0.66) return "#7fd6a6";
    if (r >= 0.33) return "#ffcf7a";
    return "#ff9fb8";
  }

  function fmtAge(ms) {
    const d = ms / DAY_MS;
    if (d < 1) return Math.max(1, Math.round(d * 24)) + " 小时前";
    if (d < 30) return Math.round(d) + " 天前";
    return Math.round(d / 30) + " 个月前";
  }

  function buildMemoryUI(state, container) {
    container.innerHTML =
      '<div class="roche-plugin-browser-mcp">' +
      '  <div class="bmcp-bar">' +
      '    <button class="bmem-back">返回</button>' +
      "    <h1>记忆管理</h1>" +
      '    <button class="bmem-decay" title="模拟一次遗忘：清理几乎已忘记的记忆">遗忘扫描</button>' +
      "  </div>" +
      '  <div class="bmem-topbar">' +
      '    <select class="bmem-conv"></select>' +
      '    <button class="bmem-refresh">刷新</button>' +
      "  </div>" +
      '  <div class="bmem-stat"></div>' +
      '  <div class="bmem-list"></div>' +
      "</div>";

    const q = function (sel) {
      return container.querySelector(sel);
    };
    const convSelect = q(".bmem-conv");
    const statEl = q(".bmem-stat");
    const listEl = q(".bmem-list");

    q(".bmem-back").onclick = function () {
      state.roche.ui.closeApp();
    };

    // 会话下拉
    (state.conversations || []).forEach(function (c) {
      const id = c.id || c.conversationId;
      if (!id) return;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent =
        (c.isGroup ? "👥 " : "💬 ") + (c.name || c.title || c.handle || id);
      convSelect.appendChild(opt);
    });
    if (state.mountedConvId) convSelect.value = state.mountedConvId;
    else if (convSelect.options.length) state.memViewConvId = convSelect.value;
    state.memViewConvId = convSelect.value;

    async function render() {
      const convId = convSelect.value;
      state.memViewConvId = convId;
      if (!convId) {
        listEl.innerHTML =
          '<div class="bmcp-empty">没有可管理的会话。</div>';
        statEl.textContent = "";
        return;
      }
      listEl.innerHTML = '<div class="bmcp-empty">读取记忆中…</div>';

      const synced = await syncMemories(state, convId);
      const meta = synced.meta;
      const now = Date.now();
      const ids = Object.keys(meta);

      if (!ids.length) {
        listEl.innerHTML =
          '<div class="bmcp-empty">这个会话还没有事实记忆。<br>在聊天里多互动，或用浏览器 MCP 写入。</div>';
        statEl.textContent = "共 0 条记忆";
        return;
      }

      // 按留存率从低到高排（快忘的排前面，提醒复习）
      ids.sort(function (a, b) {
        return retention(meta[a], now) - retention(meta[b], now);
      });

      let recalled = 0;
      let fading = 0;
      let pinned = 0;
      listEl.innerHTML = "";

      ids.forEach(function (id) {
        const m = meta[id];
        const r = retention(m, now);
        if (m.pinned) pinned++;
        else if (r >= RECALL_THRESHOLD) recalled++;
        else fading++;

        const pct = Math.round(r * 100);
        const age = fmtAge(now - (m.last || m.first || now));

        const imp = clampImp(m.imp);
        const impOptions = [1, 2, 3, 4]
          .map(function (v) {
            return (
              '<option value="' +
              v +
              '"' +
              (v === imp ? " selected" : "") +
              ">" +
              IMPORTANCE_LABEL[v] +
              "</option>"
            );
          })
          .join("");

        const item = document.createElement("div");
        item.className = "bmem-item";
        item.innerHTML =
          '<div class="txt">' +
          escapeHtml(m.text || "(空)") +
          "</div>" +
          '<div class="bmem-meter"><i style="width:' +
          pct +
          "%;background:" +
          retentionColor(r) +
          '"></i></div>' +
          '<div class="bmem-row">' +
          '<span class="bmem-pill' +
          (m.pinned ? " pinned" : "") +
          '">' +
          (m.pinned ? "📌 已钉住" : "留存 " + pct + "%") +
          "</span>" +
          '<span class="bmem-pill imp' +
          imp +
          '">' +
          IMPORTANCE_LABEL[imp] +
          "</span>" +
          "<span>复习 " +
          (m.recall || 0) +
          " 次</span>" +
          "<span>最近 " +
          age +
          "</span>" +
          '<span class="grow"></span>' +
          '<select class="bmem-imp" title="重要度">' +
          impOptions +
          "</select>" +
          '<button class="bmem-pin">' +
          (m.pinned ? "取消钉住" : "钉住") +
          "</button>" +
          '<button class="bmem-boost">复习</button>' +
          '<button class="bmem-del">遗忘</button>' +
          "</div>";

        // 改重要度
        item.querySelector(".bmem-imp").onchange = async function (e) {
          setImportance(m, e.target.value);
          await saveMeta(state, convId, meta);
          render();
        };
        // 钉住 / 取消
        item.querySelector(".bmem-pin").onclick = async function () {
          m.pinned = !m.pinned;
          await saveMeta(state, convId, meta);
          render();
        };
        // 复习：强化 + 刷新时间
        item.querySelector(".bmem-boost").onclick = async function () {
          reinforce(m);
          await saveMeta(state, convId, meta);
          state.roche.ui.toast("已复习，记忆强度提升");
          render();
        };
        // 遗忘：删主记忆 + 影子档案
        item.querySelector(".bmem-del").onclick = async function () {
          const ok = await state.roche.ui.confirm({
            title: "遗忘这条记忆",
            message:
              "确定让角色彻底忘记这条记忆吗？\n这会从 Roche 主记忆里删除，不可恢复。",
          });
          if (!ok) return;
          if (m.rocheId) {
            try {
              await state.roche.memory.delete(m.rocheId);
            } catch (e) {
              state.roche.ui.toast(
                "删除主记忆失败：" + (e && e.message ? e.message : e)
              );
            }
          }
          delete meta[id];
          await saveMeta(state, convId, meta);
          render();
        };

        listEl.appendChild(item);
      });

      statEl.textContent =
        "共 " +
        ids.length +
        " 条 · 清晰 " +
        recalled +
        " · 模糊 " +
        fading +
        " · 钉住 " +
        pinned;
    }

    convSelect.onchange = render;
    q(".bmem-refresh").onclick = render;

    // 遗忘扫描：批量清理几乎忘光的
    q(".bmem-decay").onclick = async function () {
      const convId = convSelect.value;
      if (!convId) return;
      const meta = await loadMeta(state, convId);
      const dead = decayScan(meta, Date.now());
      if (!dead.length) {
        state.roche.ui.toast("没有需要遗忘的记忆");
        return;
      }
      const ok = await state.roche.ui.confirm({
        title: "遗忘扫描",
        message:
          "检测到 " +
          dead.length +
          " 条几乎已被遗忘的记忆，是否清理？\n（会从 Roche 主记忆删除）",
      });
      if (!ok) return;
      for (const id of dead) {
        const m = meta[id];
        if (m && m.rocheId) {
          try {
            await state.roche.memory.delete(m.rocheId);
          } catch (e) {}
        }
        delete meta[id];
      }
      await saveMeta(state, convId, meta);
      state.roche.ui.toast("已遗忘 " + dead.length + " 条记忆");
      render();
    };

    render();
  }

  // ------------------------------------------------------------
  // 注册插件
  // ------------------------------------------------------------
  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "浏览器 MCP",
    version: "1.3.0",
    apps: [
      {
        id: APP_ID,
        name: "浏览器 MCP",
        icon: "public",
        iconImage: "",
        async mount(container, roche) {
          const state = createState();
          state.roche = roche;
          // 把实例状态挂到容器上，供 unmount 清理
          container.__bmcpState = state;

          injectStyle();

          // 读取已保存设置（storage + localStorage 双读兜底，长期挂载）
          try {
            state.proxyUrl = (await storeGet(state, KEY_PROXY)) || "";
            state.searchProxyUrl =
              (await storeGet(state, KEY_SEARCH)) || "";
            const s = await storeGet(state, KEY_MAXSTEPS);
            if (s) state.maxSteps = s;
            state.mountedConvId =
              (await storeGet(state, KEY_CONVO)) || "";
            state.autoWrite = !!(await storeGet(state, KEY_AUTOWRITE));
            state.readerMode =
              (await storeGet(state, KEY_READER)) === "jina"
                ? "jina"
                : "raw";
            state.siteAuth =
              (await storeGet(state, KEY_SITEAUTH)) || [];
          } catch (e) {}

          // 拉取会话列表（用于挂载角色/记忆），失败不阻塞
          try {
            if (roche.conversation && roche.conversation.list) {
              state.conversations =
                (await roche.conversation.list()) || [];
            }
          } catch (e) {
            state.conversations = [];
          }

          buildUI(state, container);
        },
        async unmount(container, roche) {
          const state = container.__bmcpState;
          if (state) {
            state.abort = true;
            (state.timers || []).forEach(function (t) {
              clearInterval(t);
              clearTimeout(t);
            });
          }
          container.__bmcpState = null;
          removeStyle();
          container.replaceChildren();
        },
      },
      {
        id: MEM_APP_ID,
        name: "记忆管理",
        icon: "psychology",
        iconImage: "",
        async mount(container, roche) {
          const state = createState();
          state.roche = roche;
          container.__bmcpState = state;
          injectStyle();

          try {
            state.mountedConvId =
              (await storeGet(state, KEY_CONVO)) || "";
          } catch (e) {}
          try {
            if (roche.conversation && roche.conversation.list) {
              state.conversations =
                (await roche.conversation.list()) || [];
            }
          } catch (e) {
            state.conversations = [];
          }

          buildMemoryUI(state, container);
        },
        async unmount(container, roche) {
          const state = container.__bmcpState;
          if (state) {
            state.abort = true;
            (state.timers || []).forEach(function (t) {
              clearInterval(t);
              clearTimeout(t);
            });
          }
          container.__bmcpState = null;
          removeStyle();
          container.replaceChildren();
        },
      },
    ],
  });
})();
