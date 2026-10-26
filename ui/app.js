(() => {
  "use strict";
  const { t, setLanguage } = globalThis.monitorI18n;
  // The UI capability is separate from the gateway key and stays in this closure.
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  let state = null,
    period = 24,
    currentOnly = false,
    editing = null,
    focusBefore = null,
    refreshing = false,
    catalogStarted = false,
    catalogRequest = null,
    catalogError = "",
    modalContext = null,
    rendered = "";
  const $ = (s) => document.querySelector(s);
  const timelineSlots = new Map();
  const timelineTargets = new Map();
  const timelineObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const { target, contentRect } of entries) {
      if (!target.isConnected) continue;
      const style = getComputedStyle(target),
        size = parseFloat(style.getPropertyValue("--timeline-cell")),
        gap = parseFloat(style.columnGap),
        slots = Math.max(
          0,
          Math.floor((contentRect.width + gap) / (size + gap)),
        ),
        key = target.dataset.timeline;
      if (timelineSlots.get(key) !== slots) {
        timelineSlots.set(key, slots);
        changed = true;
      }
    }
    if (changed) render();
  });
  const backend = (o) => o.backend || "direct-gateway";
  const backendName = (o) =>
    backend(o) === "codex-cli" ? "Codex CLI" : "原直连网关（历史）";
  const signature = () =>
    JSON.stringify({ ...state, now: Math.floor(state.now / 60000) });
  const escape = (s) =>
    String(s ?? "").replace(
      /[&<>"'\u3400-\u9fff]/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c] || `&#${c.codePointAt(0)};`,
    );
  const time = (n) =>
    n
      ? new Date(n).toLocaleString(globalThis.monitorI18n.language, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  const label = new Proxy(
    {
      success: "调用成功",
      error: "调用失败",
      timeout: "请求超时",
      interrupted: "执行中断",
      correct: "答案正确",
      incorrect: "答案错误",
      format: "答案格式不符合",
      truncated: "输出被截断",
    },
    { get: (values, key) => values[key] && t(values[key]) },
  );
  const button = (text, action, attrs = "", className = "") =>
    `<button type="button" class="${className}" data-action="${action}" ${t(attrs)}>${t(text)}</button>`;
  async function api(route, method = "GET", body) {
    const response = await fetch("/api/" + route, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401)
        throw Error(
          "页面授权已失效，请从 Magpie 插件页重新打开Codex降智检测。",
        );
      throw Error(data.error || "操作失败");
    }
    return data;
  }
  function notify(message) {
    $("#toast").textContent = t(message);
    $("#toast").style.display = "block";
    setTimeout(() => ($("#toast").style.display = "none"), 5000);
  }
  function modal(title, sub, body, context = null) {
    focusBefore = document.activeElement;
    modalContext = context;
    $("#dialog").innerHTML =
      `<div class="dialoghead flex between"><div><div class="eyebrow">${escape(t(sub))}</div><h2 id="dialogtitle">${escape(typeof title === "string" ? t(title) : title.text + t(title.suffix || ""))}</h2></div>${button("×", "close", 'aria-label="关闭"', "plain close")}</div><div class="dialogbody">${t(body)}</div>`;
    $("#overlay").classList.add("open");
    $("#dialog .close").focus();
  }
  function close() {
    modalContext = null;
    $("#overlay").classList.remove("open");
    if (focusBefore?.isConnected) focusBefore.focus();
    render();
  }
  function makeFrame(html, large = false) {
    const frame = document.createElement("iframe");
    frame.className = "preview";
    frame.title = t("隔离的 HTML/SVG 作品");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    const policy =
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
    if (large) frame.style.height = "min(65vh, 720px)";
    return frame;
  }
  function artworkNote(host, message) {
    const note = document.createElement("span");
    note.className = "thumbnail-note";
    note.dataset.message = message;
    note.textContent = t(message);
    host.append(note);
    return note;
  }
  async function fillPreviews(root = document) {
    await Promise.all(
      [...root.querySelectorAll("[data-preview]")].map(async (host) => {
        const id = host.dataset.preview;
        delete host.dataset.preview;
        const loading = artworkNote(host, "正在生成缩略图…");
        try {
          const p = await api("thumbnail/" + id);
          if (
            host.isConnected &&
            host.dataset.artifact === id &&
            !host.querySelector("img")
          ) {
            if (p.dataURL) {
              const image = document.createElement("img");
              image.src = p.dataURL;
              image.alt = t("作品截图");
              image.className = "thumbnail";
              host.prepend(image);
            }
            if (p.error || p.clipped)
              artworkNote(
                host,
                p.error === "browser"
                  ? "未找到可用截图浏览器，请在设置中指定路径"
                  : p.error
                    ? "缩略图不可用，可打开原始预览"
                    : "超出截取范围",
              );
          }
        } catch {
          if (host.isConnected && host.dataset.artifact === id)
            artworkNote(host, "预览不可用或记录已清理");
        } finally {
          loading.remove();
        }
      }),
    );
  }
  function recent(object, test) {
    return state.records.filter(
      (r) =>
        r.objectId === object.id &&
        r.testId === test.id &&
        (!currentOnly || r.historyKey === test.historyKey) &&
        r.at >= state.now - period * 3600000,
    );
  }
  function logic(object, test) {
    const rows = recent(object, test),
      success = rows.filter((r) => r.call === "success"),
      graded = rows.filter((r) => ["correct", "incorrect"].includes(r.verdict)),
      correct = graded.filter((r) => r.verdict === "correct").length;
    const pct = graded.length
      ? Math.round((correct / graded.length) * 1000) / 10
      : "—";
    const formats = rows.filter((r) => r.verdict === "format").length,
      truncated = rows.filter((r) => r.verdict === "truncated").length;
    // Width limits the visible executions, never the statistics above.
    const key = object.id + "/" + test.id,
      slots = timelineSlots.get(key) ?? 0,
      visible = rows.slice(0, slots);
    const countText = t("展示最近 {shown} 条 / 共 {total} 条")
      .replace("{shown}", visible.length)
      .replace("{total}", rows.length);
    return `<div class="logicitem"><div class="flex between"><h3>${escape(test.name)} <span class="tag">逻辑题</span>${test.enabled ? "" : " <small>已停用</small>"}</h3>${button("▷ 单题运行", "run", `data-id="${object.id}" data-test="${test.id}" ${state.busy.includes(object.id) || objectReason(object) ? "disabled" : ""}`, "plain small")}</div><div class="flex logicstats"><span class="percent">${pct}<small>%</small></span><small>答案正确 ${correct}/${graded.length} · 调用成功 ${success.length}/${rows.length}${!currentOnly && rows.some((r) => r.historyKey !== test.historyKey) ? " · 跨配置统计" : ""}${formats ? ` · 格式异常 ${formats}` : ""}${truncated ? ` · 截断 ${truncated}` : ""}</small></div><div class="timeline"><div class="bars" data-timeline="${escape(key)}">${Array.from(
      { length: slots - visible.length },
      () =>
        `<span class="timeline-empty" title="${escape(t("暂无执行记录"))}" aria-hidden="true"></span>`,
    ).join("")}${visible
      .toReversed()
      .map((r) => {
        const status = r.call === "success" ? r.verdict : r.call;
        const description = `${time(r.at)} · ${label[r.call]}${r.verdict ? " · " + label[r.verdict] : ""} · v${r.version}`;
        return button(
          "",
          "detail",
          `data-id="${r.id}" title="${escape(description)}" aria-label="${escape(description)}"`,
          "state-" + status,
        );
      })
      .join("")}</div></div><div class="revision-markers">${visible
      .filter(
        (r, i) =>
          i < visible.length - 1 && r.historyKey !== visible[i + 1].historyKey,
      )
      .map((r) => `<small>配置变更 ${time(r.at)} · v${r.version} </small>`)
      .join(
        "",
      )}</div><div class="axis"><span>${escape(countText)}</span><span>${rows.length ? "最新 " + time(rows[0].at) : "所选范围暂无记录"}</span></div></div>`;
  }
  function drawing(object, test) {
    const rows = state.records.filter(
        (r) => r.objectId === object.id && r.testId === test.id,
      ),
      latest = rows.find((r) => r.hasArtifact),
      last = rows[0];
    return `<div class="testrow"><div class="flex between artheading"><h3>${escape(test.name)} <span class="tag">绘图</span></h3>${button("▷ 运行", "run", `data-id="${object.id}" data-test="${test.id}" ${state.busy.includes(object.id) || objectReason(object) ? "disabled" : ""}`, "plain small")}</div>${latest ? `<div class="artstage" data-artifact="${latest.id}" data-preview="${latest.id}">${button("放大 ↗", "detail", `data-id="${latest.id}"`, "small")}</div>` : '<div class="empty art-empty">尚无完整作品</div>'}<div class="flex between artcaption"><div class="artmetrics"><small>创建于 ${time(latest?.finishedAt ?? latest?.at)}</small><br><small>耗时 ${latest && Number.isFinite(latest.finishedAt - latest.at) && latest.finishedAt >= latest.at ? ((latest.finishedAt - latest.at) / 60000).toFixed(2) : "—"} 分钟 · Token ${latest?.tokenTotal != null ? (latest.tokenTotal / 1000).toFixed(2) + "k" : "—"}</small>${latest && latest.historyKey !== test.historyKey ? '<br><small class="old-config">来自旧配置</small>' : ""}</div>${button("历史图片 ↗", "gallery", `data-test="${test.id}" data-name="${escape(test.name)}"`, "small")}</div>${last && !last.hasArtifact ? `<div class="warning">${time(last.at)} · ${escape(label[last.verdict] || label[last.call] || "未提取到完整作品")}；${latest ? "当前展示旧作品" : "尚无作品"} ${button("详情", "detail", `data-id="${last.id}"`, "plain small")}</div>` : ""}</div>`;
  }
  function objectReason(object) {
    if (object.needsConversion || backend(object) !== "codex-cli")
      return "旧直连对象待确认转为 Codex CLI";
    if (!state.connection.connected)
      return catalogRequest && state.connection.updatedAt === null
        ? "正在检查原生 Codex 接入与模型目录…"
        : state.connection.reason;
    if (!state.connection.models.some((m) => m.id === object.target))
      return "所选模型已不在 Codex 可见目录中";
    return "";
  }
  function objectStatus(object) {
    const kind =
      state.running === object.id
        ? "running"
        : state.queued.includes(object.id)
          ? "queued"
          : object.enabled && !objectReason(object)
            ? "enabled"
            : "paused";
    const text =
      kind === "running"
        ? "执行中"
        : kind === "queued"
          ? "排队中"
          : object.needsConversion
            ? "待确认转换"
            : object.enabled
              ? objectReason(object)
                ? "等待接入"
                : "监测中"
              : "已暂停";
    return `<span class="status status-${kind}" role="status">${text}</span>`;
  }
  // Keep unchanged iframe browsing contexts (and keyboard focus) alive across polls.
  function patch(target, source) {
    if (
      target.nodeType !== source.nodeType ||
      target.nodeName !== source.nodeName
    ) {
      target.replaceWith(source);
      return;
    }
    if (target.nodeType === Node.TEXT_NODE) {
      if (target.data !== source.data) target.data = source.data;
      return;
    }
    if (target.nodeType !== Node.ELEMENT_NODE) return;
    if (
      target === document.activeElement &&
      ["action", "id", "test"].some(
        (key) => target.dataset[key] !== source.dataset[key],
      )
    )
      target.blur();
    if (
      target.dataset.artifact &&
      target.dataset.artifact === source.dataset.artifact
    ) {
      const oldButton = target.querySelector("button"),
        newButton = source.querySelector("button");
      if (oldButton && newButton) patch(oldButton, newButton);
      const frame = target.querySelector("iframe");
      if (frame) frame.title = t("隔离的 HTML/SVG 作品");
      const image = target.querySelector("img");
      if (image) image.alt = t("作品截图");
      for (const note of target.querySelectorAll(".thumbnail-note"))
        note.textContent = t(note.dataset.message);
      return;
    }
    for (const attr of [...target.attributes])
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of source.attributes)
      if (target.getAttribute(attr.name) !== attr.value)
        target.setAttribute(attr.name, attr.value);
    const old = [...target.childNodes],
      next = [...source.childNodes];
    next.forEach((node, i) =>
      old[i] ? patch(old[i], node) : target.append(node),
    );
    old.slice(next.length).forEach((node) => node.remove());
  }
  function render() {
    if (!state) return;
    const today = new Date(state.now);
    today.setHours(0, 0, 0, 0);
    const day = state.records.filter((r) => r.at >= today.getTime()),
      successful = day.filter((r) => r.call === "success").length,
      rates = `${day.length ? Math.round((successful / day.length) * 1000) / 10 + "%" : "—"}<small> · ${successful}/${day.length}</small>`;
    const template = document.createElement("template");
    template.innerHTML = t(
      `<div class="page-head flex between"><div><h1>Codex降智检测</h1></div><div class="flex header-actions">${button("刷新 Codex 目录", "refresh-catalog")}${button("设置", "settings")}${button("＋ 新建监测对象", "edit", "", "primary")}</div></div><div class="connection catalog-feedback" role="status" aria-live="polite" hidden></div>${state.error ? `<div class="warning">${escape(state.error)}</div>` : ""}<div class="metricrow"><div class="metric"><div class="label">已启用对象</div><div class="value">${state.objects.filter((o) => o.enabled).length}<small> / ${state.objects.length}</small></div></div><div class="metric"><div class="label">今日请求</div><div class="value">${day.length}<small> 次</small></div></div><div class="metric"><div class="label">调用成功率</div><div class="value">${rates}</div></div><div class="metric"><div class="label">当前执行</div><div class="value">${state.running ? 1 : 0}<small> 个对象${state.queued.length ? ` · 排队中 ${state.queued.length}` : ""}</small></div></div></div><div class="toolbar"><div class="flex"><strong>监测对象</strong><span class="tag">${state.objects.length}</span><small class="catalog-connection-label">${state.connection.connected ? "原生 Codex 已接入" : "等待接入"}</small><small>列表更新于 ${time(state.connection.updatedAt)}</small></div><div class="seg">${button(currentOnly ? "仅当前配置" : "全部配置", "scope")}${button("最近 24 小时", "period", 'data-hours="24"', period === 24 ? "selected" : "")}${button("最近 7 天", "period", 'data-hours="168"', period === 168 ? "selected" : "")}</div></div>${
        state.objects.length
          ? state.objects
              .map(
                (o) =>
                  `<section class="card"><div class="cardhead flex between"><div><h2>${escape(o.name)}</h2><small class="mono">${escape(o.target)} <span class="tag">${escape(o.effort || "默认")}</span> <span class="tag">${escape(t(backendName(o)))}</span></small></div><div class="flex">${objectStatus(o)}${button("全部历史", "history", `data-id="${o.id}"`, "small")}${button(o.enabled ? "暂停" : "启用", "toggle", `data-id="${o.id}" ${o.needsConversion ? "disabled" : ""}`, "small")}${button("编辑", "edit", `data-id="${o.id}"`, "small")}${button("▷ 执行一轮", "run", `data-id="${o.id}" ${state.busy.includes(o.id) || objectReason(o) ? "disabled" : ""}`, "primary small")}</div></div><div class="cardbody">${objectReason(o) ? `<p class="note">${escape(t(objectReason(o)))}</p>` : ""}<div class="flex between muted"><small>每 ${o.intervalMinutes} 分钟 · ${o.tests.filter((t) => t.enabled).length} 个启用测试项 · 预计 ${Math.round((1440 / o.intervalMinutes) * o.tests.filter((t) => t.enabled).length)} 次/天</small><small>下次 ${time(o.nextAt)}</small></div><div class="object-layout ${o.tests.some((t) => t.kind === "logic") && o.tests.some((t) => t.kind === "drawing") ? "" : "single-column"}">${
                    o.tests.some((t) => t.kind === "logic")
                      ? `<div>${o.tests
                          .filter((t) => t.kind === "logic")
                          .map((t) => logic(o, t))
                          .join("")}</div>`
                      : ""
                  }${
                    o.tests.some((t) => t.kind === "drawing")
                      ? `<div class="drawing-tests">${o.tests
                          .filter((t) => t.kind === "drawing")
                          .map((t) => drawing(o, t))
                          .join("")}</div>`
                      : ""
                  }</div></div></section>`,
              )
              .join("")
          : '<div class="empty"><h2>从一组固定题目开始</h2><p>新建监测对象，选择模型或路由，然后添加逻辑题与绘图题。</p><p>新建默认暂停，不会自动消耗额度。</p></div>'
      }<div class="legend"><span>● 正确</span><span>× 错误</span><span>△ 调用异常 / 格式 / 截断</span></div>`,
    );
    const source = document.createElement("main");
    source.className = "canvas";
    source.id = "app";
    source.append(template.content);
    patch($("#app"), source);
    for (const [line, key] of timelineTargets)
      if (!line.isConnected || line.dataset.timeline !== key) {
        timelineObserver.unobserve(line);
        timelineTargets.delete(line);
      }
    const activeTimelines = new Set();
    for (const line of $("#app").querySelectorAll(".bars[data-timeline]")) {
      activeTimelines.add(line.dataset.timeline);
      if (!timelineTargets.has(line)) {
        timelineTargets.set(line, line.dataset.timeline);
        timelineObserver.observe(line);
      }
    }
    for (const key of timelineSlots.keys())
      if (!activeTimelines.has(key)) timelineSlots.delete(key);
    rendered = signature();
    updateCatalogFeedback();
    void fillPreviews($("#app"));
  }
  async function refresh(force = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      state = await api("state");
      if (!catalogStarted) {
        catalogStarted = true;
        void refreshCatalog();
      }
      updateModelPicker();
      updateCatalogFeedback();
      $("#connection-error")?.remove();
      if (
        (force || rendered !== signature()) &&
        !$("#overlay").classList.contains("open")
      )
        render();
    } catch (e) {
      notify(e.message);
      if (!$("#connection-error"))
        $("#app").insertAdjacentHTML(
          "afterbegin",
          '<div id="connection-error" class="connection warning">页面连接已中断；以下内容可能是旧数据。' +
            escape(e.message) +
            button("重新连接", "reopen", "", "small") +
            "</div>",
        );
    } finally {
      refreshing = false;
    }
  }
  function field(label, name, value, type = "text") {
    const control =
      name === "answers"
        ? `<textarea name="${name}">${escape(value)}</textarea>`
        : `<input name="${name}" type="${type}" value="${escape(value)}" ${type === "number" ? 'min="1"' : ""}>`;
    return `<div class="field"><label>${escape(t(label))}${control}</label></div>`;
  }
  function testFields(test, index) {
    return `<div class="testrow" data-index="${index}"><div class="flex between"><h3>测试项 ${index + 1} · ${test.kind === "logic" ? "逻辑题" : "HTML/SVG 绘图"}</h3>${button("移除此项", "remove-test", `data-index="${index}"`, "plain small")}</div><div class="testfields">${field("名称", "name", test.name)}${field("输出 token 上限", "maxTokens", test.maxTokens, "number")}<div class="field" style="grid-column:1/-1"><label>固定提示词</label><textarea name="prompt">${escape(test.prompt)}</textarea></div>${test.kind === "logic" ? field("标准答案及等价答案（每行一个）", "answers", test.answers.join("\n")) : ""}</div><label><input type="checkbox" name="enabled" ${test.enabled ? "checked" : ""}> 启用此测试项</label>${test.kind === "logic" ? `<label><input type="checkbox" name="gradingMode" ${test.gradingMode === "full-text" ? "checked" : ""}> 全文答案兼容模式（可能将推理中的答案误判为正确）</label>` : ""}<p class="note">${test.kind === "logic" ? "附加要求：先给出解题过程，最后单独一行输出 FINAL_ANSWER: <答案>。标准答案仅在本地判分。" : "附加要求：只输出完整 HTML，仅 HTML/CSS/内联 SVG，禁止脚本、外部资源、表单和跳转。"}</p></div>`;
  }
  function collect() {
    if (!editing || !$("#objectform")) return;
    const f = $("#objectform");
    editing.name = f.elements.objectName.value;
    editing.target = f.elements.target.value;
    editing.backend = "codex-cli";
    editing.effort = f.elements.effort.value;
    editing.intervalMinutes = Number(f.elements.intervalMinutes.value);
    editing.timeoutSeconds = Number(f.elements.timeoutSeconds.value);
    f.querySelectorAll(".testrow").forEach((row) => {
      const t = editing.tests[Number(row.dataset.index)];
      for (const name of ["name", "prompt"])
        t[name] = row.querySelector(`[name="${name}"]`).value;
      t.maxTokens = Number(row.querySelector('[name="maxTokens"]').value);
      t.enabled = row.querySelector('[name="enabled"]').checked;
      t.gradingMode = row.querySelector('[name="gradingMode"]')?.checked
        ? "full-text"
        : "final-answer";
      if (t.kind === "logic")
        t.answers = row
          .querySelector('[name="answers"]')
          .value.split(/\n/)
          .map((x) => x.trim())
          .filter(Boolean);
    });
  }
  function updateModelPicker() {
    const picker = $("#model-picker"),
      form = $("#objectform");
    if (modalContext !== "editor" || !picker || form?.dataset.saving) return;
    const value = form.elements.target.value,
      model = state.connection.models.find((m) => m.id === value),
      choices = picker.querySelector(".choices"),
      busy = Boolean(catalogRequest);
    picker.setAttribute("aria-busy", String(busy));
    picker.querySelector(".model-value").textContent = model
      ? (model.name || model.id) + " · " + model.id
      : value || t("请从下拉目录选择");
    const key = JSON.stringify([
      state.connection.models,
      value,
      busy,
      globalThis.monitorI18n.language,
    ]);
    if (choices.dataset.signature !== key) {
      const focused = choices.contains(document.activeElement)
        ? document.activeElement.dataset.value
        : null;
      choices.innerHTML = state.connection.models.length
        ? state.connection.models
            .map((m) =>
              button(
                escape((m.name || m.id) + " · " + m.id),
                "pick-model",
                `data-value="${escape(m.id)}" aria-pressed="${m.id === value}"`,
                "small" + (m.id === value ? " selected" : ""),
              ),
            )
            .join("")
        : `<small>${t(busy ? "正在刷新模型目录…" : "暂无可用目录；请检查原生 Codex 接入并刷新。")}</small>`;
      choices.dataset.signature = key;
      if (focused != null)
        (
          [...choices.querySelectorAll("button")].find(
            (b) => b.dataset.value === focused,
          ) || picker.querySelector("summary")
        ).focus({ preventScroll: true });
    }
    picker.querySelector(".catalog-time").textContent =
      t("列表更新于") + " " + time(state.connection.updatedAt);
    picker.querySelector('[data-action="catalog"]').disabled = busy;
    const error =
      catalogError ||
      (!state.connection.connected
        ? state.connection.reason
        : value && !model
          ? "所选模型已不在 Codex 可见目录中"
          : "");
    const status = picker.querySelector(".catalog-status");
    status.textContent = t(busy ? "正在刷新模型目录…" : error);
    status.classList.toggle("warning", !busy && Boolean(error));
  }
  function updateCatalogFeedback() {
    if (!state) return;
    const busy = Boolean(catalogRequest),
      control = $('[data-action="refresh-catalog"]'),
      feedback = $(".catalog-feedback"),
      connection = $(".catalog-connection-label"),
      error =
        catalogError ||
        (!state.connection.connected ? state.connection.reason : "");
    if (control) {
      control.disabled = busy;
      control.setAttribute("aria-busy", String(busy));
      const text = t(busy ? "正在刷新…" : "刷新 Codex 目录");
      if (
        control.textContent !== text ||
        Boolean(control.querySelector(".catalog-spinner")) !== busy
      )
        control.innerHTML =
          (busy
            ? '<span class="catalog-spinner" aria-hidden="true"></span>'
            : "") + `<span>${escape(text)}</span>`;
    }
    if (feedback) {
      feedback.textContent = t(
        busy ? "正在检查原生 Codex 接入与模型目录…" : error,
      );
      feedback.hidden = !busy && !error;
      feedback.classList.toggle("warning", !busy && Boolean(error));
    }
    if (connection)
      connection.textContent = t(
        busy
          ? "正在刷新…"
          : state.connection.connected
            ? "原生 Codex 已接入"
            : "等待接入",
      );
  }
  function refreshCatalog() {
    if (catalogRequest) return catalogRequest;
    catalogError = "";
    catalogRequest = (async () => {
      try {
        state.connection = await api("catalog");
      } catch (error) {
        catalogError = error.message;
        state.connection = {
          ...state.connection,
          connected: false,
          reason: error.message,
        };
      } finally {
        catalogRequest = null;
        // Update only the picker, never reopen a dialog or replace its draft.
        updateModelPicker();
        updateCatalogFeedback();
        if (!$("#overlay").classList.contains("open")) render();
      }
    })();
    updateModelPicker();
    updateCatalogFeedback();
    return catalogRequest;
  }
  function edit(id, reuse = false) {
    if (!reuse)
      editing = id
        ? structuredClone(state.objects.find((o) => o.id === id))
        : {
            name: "",
            target: "",
            backend: "codex-cli",
            effort: "",
            enabled: false,
            intervalMinutes: 30,
            timeoutSeconds: 300,
            tests: [],
          };
    modal(
      editing.id ? "编辑监测对象" : "新建监测对象",
      "修改仅影响后续轮次 · 新建默认暂停",
      `<form id="objectform"><div class="formgrid"><div>${field("对象名称", "objectName", editing.name)}<input type="hidden" name="backend" value="codex-cli"><p class="note">执行后端：Codex CLI</p>${editing.needsConversion ? '<p class="warning">保存将确认转为 Codex CLI；原历史不变，转换后仍暂停。</p>' : ""}<p class="warning">Codex CLI 继承本机配置与认证；只读不等于无工具或无联网。输出 token 上限仅为提示要求，非硬限制。</p><div class="field picker" id="model-picker"><span class="model-label" id="model-picker-label">Codex 可见模型</span><input type="hidden" name="target" value="${escape(editing.target)}"><details><summary aria-labelledby="model-picker-label model-picker-value"><span class="model-value" id="model-picker-value"></span><span class="picker-arrow" aria-hidden="true"></span></summary><div class="choices"></div></details><div class="picker-meta"><small class="catalog-time"></small>${button("刷新模型与路由目录", "catalog", "", "plain small")}</div><small class="catalog-status" role="status" aria-live="polite"></small></div><div class="field"><label>请求推理强度（不代表实际生效值）</label><input name="effort" value="${escape(editing.effort)}" placeholder="留空使用默认；支持 high、medium 等"><div class="chips">${["", "low", "medium", "high", "xhigh"].map((v) => button(v || "默认", "pick-effort", `data-value="${v}"`, "small")).join("")}</div></div></div><div>${field("执行间隔 / 分钟", "intervalMinutes", editing.intervalMinutes, "number")}${field("单次超时 / 秒", "timeoutSeconds", editing.timeoutSeconds, "number")}<div class="detailblock"><small>预计每日请求数（不含路由内部重试）</small><p id="estimate" style="font:28px var(--mono)">${Math.round((1440 / editing.intervalMinutes) * editing.tests.filter((t) => t.enabled).length)}</p><small>全局串行 · 不自动重试</small></div></div></div><div class="divider"></div><div class="flex between"><h3>测试项</h3><div class="flex">${button("＋ 逻辑题", "add-test", 'data-kind="logic"')}${button("＋ 绘图题", "add-test", 'data-kind="drawing"')}</div></div>${editing.tests.map(testFields).join("")}<p id="formerror" class="modalerror" role="alert"></p><div class="buttonrow">${editing.id ? button("删除对象及历史", "delete", `data-id="${editing.id}"`, "plain") : ""}${button("保存配置", "save-object", "", "primary")}</div></form>`,
      "editor",
    );
    updateModelPicker();
  }
  async function detail(id) {
    const r = await api("records/" + id);
    modal(
      { text: r.test.name },
      "历史快照 · 只读 · " + time(r.at),
      `<div class="flex between"><span class="status">${escape(label[r.call])}${r.verdict ? " · " + escape(label[r.verdict]) : ""}</span><span class="readonly">配置 v${r.snapshot.version} · 只读</span></div><div class="detailstats" style="margin-top:20px"><div><small>请求目标</small><strong style="font-size:13px">${escape(r.snapshot.target)}</strong></div><div><small>请求强度</small><strong>${escape(r.snapshot.effort || "默认")}</strong></div><div><small>实际命中</small><strong style="font-size:13px">${escape(r.actualModel || "未获取")}</strong></div><div><small>耗时</small><strong>${((r.finishedAt - r.at) / 60000).toFixed(2)} 分钟</strong></div></div><p class="note">${escape(t(backendName(r.snapshot)))} · ${escape(r.transport || "chat-completions")} · ${escape(r.toolPolicy || "none")}</p>${r.transport === "codex-exec" ? `<p class="warning">CLI 耗时包含启动与进程通信；输出 token 上限非硬限制。</p>` : ""}${r.error ? `<div class="warning">${escape(r.error)}</div>` : ""}${r.artifact ? `<div class="artstage large-art" data-artifact="${r.id}" data-preview="${r.id}"></div><div class="buttonrow">${button("重试截图", "retry-thumbnail", `data-id="${r.id}"`, "small")}</div><details class="raw-preview"><summary>原始预览（可滚动，含动画）</summary><div id="largepreview"></div></details>` : ""}<div class="detailgrid"><div><h3>${r.transport === "codex-exec" ? "CLI 标准输入（非完整上游请求）" : "实际发送内容"}</h3><pre>${escape(r.request.stdin ?? r.request.messages?.[0]?.content ?? "")}</pre>${r.test.kind === "logic" ? `<small>本地标准答案：${escape(r.test.answers.join(" / "))}<br>提取答案：${escape(r.answer ?? "未提取")}<br>判分规则：${r.test.gradingMode === "full-text" ? "全文答案兼容模式（可能将推理中的答案误判为正确）" : r.test.answerRule === "normalized-v1" ? "忽略全半角、空白与末尾句号" : "首尾去空白后精确比较"}</small>` : ""}</div><div><h3>原始回答</h3><pre>${escape(r.raw || "无完整文本回答")}</pre><small>${escape(r.extraction || "")}</small></div></div><details><summary>请求参数与 token 信息</summary><pre>${escape(JSON.stringify({ backend: backend(r.snapshot), transport: r.transport || "chat-completions", toolPolicy: r.toolPolicy || "none", maxTokensEnforced: r.maxTokensEnforced ?? true, gradingMode: r.test.kind === "logic" ? r.test.gradingMode || "final-answer" : null, answerRule: r.test.answerRule || "exact-v0", cli: r.cli, request: r.request, usage: r.usage }, null, 2))}</pre></details>`,
    );
    if (r.artifact) {
      const host = $("#largepreview");
      const p = await api("preview/" + r.id);
      if (host?.isConnected) {
        host.append(makeFrame(p.html, true));
        void fillPreviews($("#dialog"));
      }
    }
  }
  async function gallery(testId, name, page = 1) {
    const g = await api(`gallery/${testId}?page=${page}`);
    modal(
      { text: name, suffix: " · 历史作品" },
      `新到旧 · 每页 20 张 · 共 ${g.total} 张 · 不进行质量评分`,
      `<div class="gallery">${g.items.map((r) => `<div><div class="artstage" data-gallery-id="${r.id}" data-artifact="${r.id}" data-preview="${r.id}">${button("放大", "detail", `data-id="${r.id}"`, "small")}</div><small>创建于 ${time(r.finishedAt ?? r.at)} · v${r.version} · ${escape(backendName(r))}</small></div>`).join("")}</div>${g.total ? "" : '<div class="empty">暂无完整作品</div>'}<div class="pagination"><small>第 ${page} / ${Math.max(1, Math.ceil(g.total / 20))} 页</small><div class="flex">${button("← 上一页", "gallery", `data-test="${testId}" data-name="${escape(name)}" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}`)}${button("下一页 →", "gallery", `data-test="${testId}" data-name="${escape(name)}" data-page="${page + 1}" ${page * 20 >= g.total ? "disabled" : ""}`)}</div></div>`,
    );
    void fillPreviews($("#dialog"));
  }
  function historyList(b) {
    const d = b.dataset || b,
      page = Number(d.page || 1);
    const rows = state.records.filter(
      (r) =>
        r.objectId === d.id &&
        (!d.test || r.testId === d.test) &&
        (!d.version || r.version === Number(d.version)) &&
        (!d.key || r.historyKey === d.key) &&
        (!d.from || r.at >= Number(d.from)) &&
        (!d.to || r.at < Number(d.to)),
    );
    const attrs = `data-id="${d.id}" data-test="${d.test || ""}" data-version="${d.version || ""}" data-key="${d.key || ""}" data-from="${d.from || ""}" data-to="${d.to || ""}"`;
    modal(
      "执行历史",
      "包含保留期内所有配置版本 · 每页 100 条 · 只读",
      `<div class="historylist">${
        rows
          .slice((page - 1) * 100, page * 100)
          .map((r) =>
            button(
              `${time(r.at)} · v${r.version} · ${escape(r.testName)} · ${escape(backend(r))} · ${escape(label[r.verdict] || label[r.call])}`,
              "detail",
              `data-id="${r.id}"`,
              "historyrecord",
            ),
          )
          .join("") || '<div class="empty">暂无记录</div>'
      }</div><div class="pagination"><small>共 ${rows.length} 条 · 第 ${page} / ${Math.max(1, Math.ceil(rows.length / 100))} 页</small><div class="flex">${button("← 上一页", "history", `${attrs} data-page="${page - 1}" ${page === 1 ? "disabled" : ""}`)}${button("下一页 →", "history", `${attrs} data-page="${page + 1}" ${page * 100 >= rows.length ? "disabled" : ""}`)}</div></div>`,
    );
  }
  function settings() {
    modal(
      "监测设置",
      "本地存储与接入",
      `<div class="detailblock"><h3>${state.connection.connected ? "● 已连接" : "○ 未连接"}</h3><p>${escape(t(state.connection.reason))}</p><small>请在 Magpie Agent 页面接入 Windows 原生 Codex。未知接入模式或目录读取失败时停止新执行，历史仍可查看。</small></div><form id="settingsform" style="margin-top:20px">${field("完整记录保留天数（1–365）", "retentionDays", state.settings.retentionDays, "number")}${field("Magpie CLI 绝对路径（留空自动发现）", "magpiePath", state.settings.magpiePath || "")}${field("Codex CLI 绝对路径（留空自动发现）", "codexPath", state.settings.codexPath || "")}${field("截图浏览器绝对路径（留空查找 Chrome/Edge）", "browserPath", state.settings.browserPath || "")}<p class="note">截图在无头浏览器后台执行，不打开窗口、不读取登录状态、不自动下载浏览器。</p><p class="note">路径仅指定可执行文件，不含参数；插件不修改 Codex 配置，也不回退直连。</p><p class="warning">保存较短保留期会清理到期的完整记录与作品，可先导出 JSON 留档。</p><p class="note">全局串行 · 不自动重试。空档不计模型失败 · 不评价绘图质量。固定题目不用于断言整体能力或供应商换模。</p><p class="note">异常仅在插件内提示，不发送邮件、Webhook 或桌面通知。</p><p class="modalerror" id="formerror"></p><div class="buttonrow">${button("导出历史 JSON", "export")}${button("保存设置", "save-settings", "", "primary")}</div></form>`,
    );
  }
  async function saveForm(id, button) {
    const form = document.getElementById(id);
    if (!form || form.dataset.saving) return;
    const objectForm = id === "objectform";
    if (objectForm) collect();
    const payload = objectForm
      ? structuredClone(editing)
      : {
          retentionDays: Number(form.elements.retentionDays.value),
          codexPath: form.elements.codexPath.value,
          magpiePath: form.elements.magpiePath.value,
          browserPath: form.elements.browserPath.value,
        };
    const controls = [...form.querySelectorAll("input,textarea,button")].map(
      (control) => [control, control.disabled],
    );
    const originalText = button.textContent;
    form.dataset.saving = "true";
    form.querySelector("#formerror").textContent = "";
    controls.forEach(([control]) => (control.disabled = true));
    button.textContent = t("保存中…");
    try {
      await api(
        objectForm
          ? "objects" + (payload.id ? "/" + payload.id : "")
          : "settings",
        objectForm && !payload.id ? "POST" : "PUT",
        payload,
      );
      if (form.isConnected) close();
      notify(objectForm ? "配置已保存" : "设置已保存");
      await refresh(true);
    } catch (error) {
      notify(error.message);
      if (form.isConnected)
        form.querySelector("#formerror").textContent = error.message;
    } finally {
      delete form.dataset.saving;
      controls.forEach(([control, disabled]) => (control.disabled = disabled));
      button.textContent = originalText;
      if (objectForm && form.isConnected) updateModelPicker();
    }
  }
  const actions = {
    close,
    settings,
    "save-object": (button) => saveForm("objectform", button),
    "save-settings": (button) => saveForm("settingsform", button),
    history: historyList,
    reopen: () =>
      parent.postMessage(
        {
          magpie: 1,
          method: "error",
          params: { message: "请点重试重新连接监测页面" },
        },
        "*",
      ),
    period: (b) => {
      period = Number(b.dataset.hours);
      render();
    },
    scope: () => {
      currentOnly = !currentOnly;
      render();
    },
    "refresh-catalog": refreshCatalog,
    edit: (b) => {
      edit(b.dataset.id);
      void refreshCatalog();
    },
    toggle: async (b) => {
      const o = state.objects.find((x) => x.id === b.dataset.id);
      await api("objects/" + o.id, "PUT", { ...o, enabled: !o.enabled });
      await refresh(true);
    },
    run: async (b) => {
      await api(
        "objects/" + b.dataset.id + "/run",
        "POST",
        b.dataset.test ? { testId: b.dataset.test } : {},
      );
      notify("已加入串行执行队列");
      await refresh(true);
    },
    detail: (b) => detail(b.dataset.id),
    "retry-thumbnail": async (b) => {
      b.disabled = true;
      try {
        await api("thumbnail/" + b.dataset.id, "POST", {});
        for (const host of document.querySelectorAll(
          `[data-artifact="${b.dataset.id}"]`,
        )) {
          host
            .querySelectorAll("img,.thumbnail-note")
            .forEach((node) => node.remove());
          host.dataset.preview = b.dataset.id;
        }
        await fillPreviews();
      } finally {
        b.disabled = false;
      }
    },
    gallery: (b) =>
      gallery(b.dataset.test, b.dataset.name, Number(b.dataset.page || 1)),
    "add-test": (b) => {
      collect();
      const kind = b.dataset.kind;
      editing.tests.push({
        name: "",
        kind,
        prompt: "",
        answers: [],
        enabled: true,
        maxTokens: kind === "logic" ? 8192 : 16384,
      });
      edit(null, true);
    },
    "remove-test": (b) => {
      collect();
      editing.tests.splice(Number(b.dataset.index), 1);
      edit(null, true);
    },
    "pick-model": (b) => {
      if ($("#objectform")?.dataset.saving) return;
      $("#objectform").elements.target.value = b.dataset.value;
      b.closest("details").open = false;
      updateModelPicker();
      $("#model-picker summary").focus({ preventScroll: true });
    },
    "pick-effort": (b) => {
      $("#objectform").elements.effort.value = b.dataset.value;
    },
    catalog: refreshCatalog,
    delete: (b) =>
      modal(
        "删除监测对象？",
        "此操作不能撤销",
        `<p>同时删除此对象、全部测试项及其历史记录。已发送请求的结果不会恢复已删对象。</p><div class="buttonrow">${button("取消", "close")}${button("确认删除", "confirm-delete", `data-id="${b.dataset.id}"`, "primary")}</div>`,
      ),
    "confirm-delete": async (b) => {
      await api("objects/" + b.dataset.id, "DELETE");
      close();
      await refresh(true);
    },
    export: async () => {
      const data = await api("export");
      modal(
        "历史 JSON 导出",
        "复制或在浏览器中下载留档，不包含访问凭据",
        `<p>共 ${data.records.length} 条记录。内嵌沙盒不保证支持下载，因此提供只读文本留档。</p><textarea readonly style="width:100%;height:350px">${escape(JSON.stringify(data, null, 2))}</textarea>`,
      );
    },
  };
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-action]");
    if (!b || b.disabled) return;
    e.preventDefault();
    try {
      await actions[b.dataset.action]?.(b);
    } catch (error) {
      notify(error.message);
      if ($("#formerror")) $("#formerror").textContent = error.message;
    }
  });
  // Magpie permits scripts but not native form submission. Save explicitly by
  // click (or Enter in a single-line field), without relaxing the iframe sandbox.
  document.addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("input", () => {
    if (modalContext === "editor") {
      collect();
      $("#estimate").textContent =
        editing.intervalMinutes > 0
          ? Math.round(
              (1440 / editing.intervalMinutes) *
                editing.tests.filter((t) => t.enabled).length,
            )
          : "—";
    }
  });
  $("#overlay").addEventListener("click", (e) => {
    if (e.target === $("#overlay")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Enter" &&
      !e.isComposing &&
      e.target.matches("input:not([type=checkbox])")
    ) {
      const form = e.target.closest("form");
      const action =
        form?.id === "objectform"
          ? "save-object"
          : form?.id === "settingsform"
            ? "save-settings"
            : null;
      if (action) {
        e.preventDefault();
        form.querySelector(`[data-action="${action}"]`)?.click();
      }
    }
    if (e.key === "Escape") close();
    if (e.key === "Tab" && $("#overlay").classList.contains("open")) {
      const list = [
          ...$("#dialog").querySelectorAll(
            "button:not([disabled]),input,textarea,summary",
          ),
        ].filter((x) => x.getClientRects().length),
        first = list[0],
        last = list.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  function applyTheme(data) {
    if (typeof data.dark !== "boolean" && !data.tokens) return;
    const root = document.documentElement;
    if (typeof data.dark === "boolean")
      root.dataset.theme = data.dark ? "dark" : "light";
    // Only documented host tokens; model HTML never participates in theming.
    for (const key of [
      "bg",
      "card",
      "fg",
      "fg-2",
      "muted",
      "faint",
      "line",
      "accent",
      "accent-soft",
      "accent-fg",
      "green",
      "red",
      "amber",
      "font",
      "code",
    ]) {
      const value = data.tokens?.[key];
      if (typeof value === "string" && value.trim() && value.length < 2048)
        root.style.setProperty("--" + key, value);
      else root.style.removeProperty("--" + key);
    }
  }
  applyTheme({ dark: matchMedia("(prefers-color-scheme: dark)").matches });
  addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.magpie !== 1) return;
    const data =
      e.data.event === "theme"
        ? e.data.data
        : e.data.id === 1
          ? e.data.result
          : null;
    if (data) applyTheme(data);
    if (data?.lang) {
      const previousLanguage = globalThis.monitorI18n.language;
      setLanguage(data.lang);
      if (previousLanguage === globalThis.monitorI18n.language) return;
      if (modalContext === "editor") {
        collect();
        edit(null, true);
      } else if ($("#overlay").classList.contains("open")) close();
      render();
    }
  });
  parent.postMessage({ magpie: 1, id: 1, method: "hello" }, "*");
  $("#app .empty").textContent = t("正在连接监测服务…");
  void refresh();
  let idlePolls = 0;
  setInterval(() => {
    if (state?.busy.length || ++idlePolls >= 5) {
      idlePolls = 0;
      void refresh();
    }
  }, 1000);
})();
