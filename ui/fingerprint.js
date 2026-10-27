// Production UI for independent fingerprint objects. Shared host owns auth,
// theme, localization, polling, modal focus and the existing monitor renderer.
(() => {
  "use strict";
  globalThis.createFingerprintUI = (host) => {
    const {
      api,
      modal,
      close,
      notify,
      refresh,
      escape: e,
      button: b,
      time,
      t,
      components,
    } = host;
    const state = () => host.state();
    const $ = (s) => document.querySelector(s);
    const historyFilters = new Map(),
      pending = new Map();
    let typeFilter = "all",
      editing = null,
      detailBatch = null,
      baselinePreview = null;
    const reason = (value) =>
      t(
        {
          running: "采样未完成",
          interrupted: "批次已中断",
          "calls-failed": "调用全部失败",
          insufficient: "有效样本不足 40",
          "valid-rate": "样本有效率低于 80%",
        }[value] || "未评分",
      );
    const level = (n) =>
      n >= 95 ? 5 : n >= 90 ? 4 : n >= 80 ? 3 : n >= 60 ? 2 : 1;
    const setting = (id) => {
      if (!historyFilters.has(id))
        historyFilters.set(id, { days: "all", current: false });
      return historyFilters.get(id);
    };
    const cardById = (id) => state().fingerprints.find((o) => o.id === id);
    const baselineById = (id) => state().baselines.find((r) => r.id === id);
    const batches = (card, row) =>
      state()
        .fingerprintBatches.filter(
          (r) => r.objectId === card.id && r.rowId === row.id,
        )
        .sort((a, z) => z.at - a.at);
    function timeline(card, row, records) {
      return components.timeline({
        key: card.id + "/" + row.id,
        records,
        label: `${row.name} ${t("批次序列 · 左旧右新")} · ${t("每格为一批采样")}`,
        emptyText: "暂无记录",
        cell: (r) => ({
          action: "fp-batch",
          attrs: `data-batch="${r.id}" data-level="${r.score === null ? 0 : level(r.score)}"`,
          title: `${time(r.at)} · ${t("指纹匹配度")} ${r.score === null ? reason(r.reason) : r.score.toFixed(1)} · ${t("有效样本")} ${r.valid}/${r.attempted}`,
          text:
            r.reason === "running"
              ? "·"
              : r.reason === "interrupted"
                ? "×"
                : "",
          className: `fp-cell ${r.score === null ? (r.reason === "running" ? "running" : r.reason === "interrupted" ? "interrupted" : "unscored") : ""}`,
        }),
      });
    }
    function row(card, row) {
      const records = batches(card, row),
        latest = records[0],
        p = state().fingerprintProgress.find((p) => p.objectId === card.id),
        active = p?.rowId === row.id;
      const result = latest
        ? latest.score === null
          ? `<span class="fp-unscored">${t("未评分")}</span><span class="fp-reason">${e(reason(latest.reason))}</span>`
          : `<span class="fp-score">${latest.score.toFixed(1)}<small>/100</small></span>`
        : `<span class="fp-unscored">${t("暂无结果")}</span>`;
      return `<section class="fp-row"><div class="fp-rowhead"><div><div class="fp-identity"><h3>${e(row.name)}</h3><span class="tag">${e(row.effort || t("默认"))}</span>${active ? `<span class="tag fp-tag">${t(p.state === "sampling" ? "采样中" : "等待队列")}</span>` : p?.waitingRows.includes(row.id) ? `<span class="tag">${t("等待队列")}</span>` : !row.enabled ? `<span class="tag">${t("已停用")}</span>` : ""}</div><div class="mono fp-reference">${e(row.target)}</div></div>${runButton(card, row)}</div><div class="flex logicstats fp-result">${result}${latest ? `<span>${t("有效样本")} ${latest.valid}/${latest.attempted} · ${t("样本有效率")} ${latest.attempted ? Math.round((latest.valid / latest.attempted) * 100) : 0}%</span>` : ""}</div>${timeline(card, row, records)}${active ? `<progress class="fp-progress" value="${p.attempted}" max="${p.budget}" aria-label="${t("已尝试")} ${p.attempted}/${p.budget}"></progress><div class="fp-timefoot"><span>${t("已尝试")} ${p.attempted}/${p.budget} · ${t("有效样本")} ${p.valid} · ${t("无效样本")} ${p.invalid}</span><span>${t("全局串行")}</span></div>` : ""}</section>`;
    }
    function legend() {
      return `<div class="fp-legend"><span>${t("指纹匹配度")}</span>${["0–<60", "60–<80", "80–<90", "90–<95", "95–100"].map((text, i) => `<span><i class="fp-cell" data-level="${i + 1}"></i>${text}</span>`).join("")}<span><i class="fp-cell unscored"></i>${t("未评分")}</span><span><i class="timeline-empty"></i>${t("暂无记录")}</span></div>`;
    }
    function runButton(card, row) {
      const submission = pending.get(card.id);
      return components.runButton({
        action: "fp-run",
        attrs: `data-id="${card.id}" ${row ? `data-row="${row.id}"` : ""}`,
        single: Boolean(row),
        submitting:
          submission?.action === "fp-run" &&
          submission.rowId === (row?.id || ""),
        disabled:
          state().busy.includes(card.id) ||
          pending.has(card.id) ||
          !state().connection.connected ||
          (!row && !card.rows.some((r) => r.enabled)),
      });
    }
    function card(card) {
      const busy = state().busy.includes(card.id),
        submission = pending.get(card.id),
        kind =
          state().running === card.id
            ? "running"
            : state().queued.includes(card.id)
              ? "queued"
              : card.enabled
                ? "enabled"
                : "paused",
        actions = components.cardActions({
          id: card.id,
          status: components.status(
            kind,
            kind === "running"
              ? "执行中"
              : kind === "queued"
                ? "排队中"
                : card.enabled
                  ? "定时已启用"
                  : "已暂停",
          ),
          history: "fp-history",
          edit: "fp-edit",
          pending: Boolean(submission),
          toggle: {
            action: "fp-schedule",
            text:
              submission?.action === "fp-schedule"
                ? card.enabled
                  ? "正在暂停…"
                  : "正在启用…"
                : card.enabled
                  ? "关闭定时"
                  : "启用",
            busy: submission?.action === "fp-schedule",
            title: "关闭定时不停止本轮；停止 CLI 不保证供应商停止执行或计费。",
          },
          execution: busy
            ? b(
                "停止本轮",
                "fp-stop",
                `data-id="${card.id}" ${submission ? "disabled" : ""}`,
                "small",
              )
            : runButton(card),
        });
      return `<section class="card fp-card"><div class="cardhead flex between"><div><h2>${e(card.name)} <span class="tag fp-tag">${t("指纹一致性")}</span></h2><small>${card.rows.length} ${t("个模型 · 固定基准版本")}</small></div>${actions}</div><div class="cardbody">${card.rows.map((r) => row(card, r)).join("")}${legend()}</div></section>`;
    }
    function toolbar() {
      return `<div class="fp-tabs" role="group" aria-label="${t("监测类型")}">${[
        ["all", "全部"],
        ["legacy", "逻辑与绘图"],
        ["fingerprint", "指纹一致性"],
      ]
        .map(([key, label]) =>
          b(
            label,
            "fp-filter",
            `data-filter="${key}" aria-pressed="${typeFilter === key}"`,
          ),
        )
        .join("")}</div>`;
    }
    function choose() {
      modal(
        "新建监测对象",
        "选择监测类型 · 不支持类型互转",
        `<div class="fp-types">${b("<strong>逻辑与绘图</strong><small>固定题目、答案正确率与 HTML/SVG 作品。</small>", "fp-new-legacy")}${b("<strong>指纹一致性</strong><small>多模型、固定参考基准与独立批次序列。</small>", "fp-new")}</div><p class="note">新建默认定时关闭；手动执行不会启用定时。</p>`,
      );
    }
    function editorRows() {
      return editing.rows
        .map(
          (r, i) =>
            `<div class="fp-editrow" data-fp-row="${i}"><label><input type="checkbox" data-field="enabled" aria-label="${t("启用模型行")} ${i + 1}" ${r.enabled ? "checked" : ""}></label><label>${t("显示名称")}<input data-field="name" value="${e(r.name)}" aria-label="${t("显示名称")} ${i + 1}"></label><label>${t("模型或路由")}<select data-field="target" aria-label="${t("模型或路由")} ${i + 1}">${targetOptions(r)}</select></label><label>${t("请求强度")}<select data-field="effort" aria-label="${t("请求强度")} ${i + 1}">${["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((v) => `<option value="${v}" ${v === r.effort ? "selected" : ""}>${e(v || t("默认"))}</option>`).join("")}</select></label><label class="fp-editref">${t("固定参考基准")}<select data-field="baselineId" aria-label="${t("固定参考基准")} ${i + 1}">${state()
              .baselines.filter((b) => !b.archived || b.id === r.baselineId)
              .map(
                (b) =>
                  `<option value="${b.id}" ${b.id === r.baselineId ? "selected" : ""}>${e(b.name)} · ${b.id.slice(0, 8)}</option>`,
              )
              .join(
                "",
              )}</select></label><div class="flex fp-rowops">${b("↑", "fp-up", `data-index="${i}" aria-label="${t("上移模型行")} ${i + 1}" ${i ? "" : "disabled"}`, "plain small")}${b("×", "fp-remove", `data-index="${i}" aria-label="${t("移除模型行")} ${i + 1}"`, "plain small")}</div></div>`,
        )
        .join("");
    }
    function targetOptions(row) {
      const ids = [
        ...new Set([
          ...state().connection.models.map((m) => m.id),
          ...(row.target ? [row.target] : []),
        ]),
      ];
      return (
        `<option value="">${t("请选择模型")}</option>` +
        ids
          .map(
            (id) =>
              `<option value="${e(id)}" ${row.target === id ? "selected" : ""}>${e(id)}</option>`,
          )
          .join("")
      );
    }
    function updateCatalog() {
      if (
        !$("#fp-form") ||
        !$("#overlay").classList.contains("open") ||
        $("#fp-form").dataset.saving
      )
        return;
      collect();
      document.querySelectorAll("[data-fp-row]").forEach((host) => {
        const row = editing.rows[Number(host.dataset.fpRow)],
          select = host.querySelector('[data-field="target"]'),
          options = targetOptions(row);
        if (select.dataset.fpOptions !== options) {
          select.innerHTML = options;
          select.dataset.fpOptions = options;
        }
        select.value = row.target;
      });
      const status = host.catalog();
      const control = $("[data-action=fp-catalog]");
      control.disabled = status.busy;
      control.setAttribute("aria-busy", String(status.busy));
      $("#fp-catalog-status").textContent = t(
        status.busy ? "正在刷新模型目录…" : status.error || "",
      );
    }
    function collect() {
      const form = $("#fp-form");
      if (!form) return;
      for (const key of [
        "name",
        "samples",
        "timeoutSeconds",
        "intervalMinutes",
      ])
        editing[key] =
          key === "name"
            ? form.elements[key].value
            : Number(form.elements[key].value);
      editing.enabled = form.elements.enabled.checked;
      document.querySelectorAll("[data-fp-row]").forEach((row) => {
        const data = editing.rows[Number(row.dataset.fpRow)];
        row.querySelectorAll("[data-field]").forEach((input) => {
          data[input.dataset.field] =
            input.type === "checkbox" ? input.checked : input.value;
        });
      });
    }
    function cost() {
      const n = editing.rows.filter((r) => r.enabled).length * editing.samples;
      return `<strong>${t("每轮 CLI 尝试")} ${n}</strong> · ${editing.enabled ? `${t("每日预计量")} ${editing.intervalMinutes > 0 ? Math.round((n * 1440) / editing.intervalMinutes) : "—"}` : t("定时关闭")}<small>${t("失败消耗预算，不补跑；执行规模不等于实际金额。")}</small>${editing.id ? `<small>${t("上轮耗时")} ${editing.lastDurationMs === undefined ? "—" : (editing.lastDurationMs / 60000).toFixed(1) + " min"} · ${t("下次")} ${time(editing.nextAt)}</small>` : ""}`;
    }
    const field = (label, name, value, type = "number") =>
      `<label class="fp-field">${t(label)}<input name="${name}" type="${type}" value="${e(value)}" ${type === "number" ? 'min="1" step="1"' : ""}></label>`;
    function edit(id, reuse = false) {
      if (!reuse)
        editing = id
          ? structuredClone(cardById(id))
          : {
              type: "fingerprint",
              name: "",
              enabled: false,
              samples: 50,
              timeoutSeconds: 300,
              intervalMinutes: 1440,
              rows: [newRow()],
            };
      modal(
        editing.id ? "编辑指纹监测" : "新建指纹监测",
        "实验性分布对照",
        `<form id="fp-form">${field("对象名称", "name", editing.name, "text")}<div class="fp-fields">${field("每模型尝试", "samples", editing.samples)}${field("单次超时 / 秒", "timeoutSeconds", editing.timeoutSeconds)}${field("执行间隔 / 分钟", "intervalMinutes", editing.intervalMinutes)}</div><p class="note">完整预算、有效样本至少 40 且有效率至少 80% 才评分；不是可靠性保证。</p><div class="flex between"><h3>受测模型</h3><div class="flex">${b("刷新 Codex 目录", "fp-catalog", "", "plain small")}${b("＋ 添加模型", "fp-add", "", "small")}</div></div><p id="fp-catalog-status" class="note" role="status" aria-live="polite"></p>${editorRows()}<p><label><input name="enabled" type="checkbox" ${editing.enabled ? "checked" : ""}> ${t("启用定时")}</label></p><div class="fp-cost" id="fp-cost">${cost()}</div><p class="note">模型行按顺序完成整批；所有模型共享采样次数与超时。编辑只影响后续轮次。</p><p class="note">关闭定时不停止本轮；停止 CLI 不保证供应商停止执行或计费。</p><p class="note">请求推理强度不代表实际生效值；实际命中、温度和种子可能未知。</p><p id="formerror" class="modalerror" role="alert"></p><div class="buttonrow">${editing.id ? b("删除整卡及历史", "fp-delete", `data-id="${editing.id}"`, "plain") : ""}${b("保存配置", "fp-save", "", "primary")}</div></form>`,
      );
      updateCatalog();
    }
    function newRow() {
      return {
        name: "",
        target: state().connection.models[0]?.id || "",
        effort: "",
        baselineId: state().baselines.find((b) => !b.archived)?.id || "",
        enabled: true,
      };
    }
    async function save(control) {
      const form = $("#fp-form");
      if (form.dataset.saving) return;
      collect();
      const payload = structuredClone(editing),
        inputs = [...form.querySelectorAll("input,select,button")];
      form.dataset.saving = "true";
      const disabled = inputs.map((x) => x.disabled);
      inputs.forEach((x) => (x.disabled = true));
      try {
        await api(
          "objects" + (payload.id ? "/" + payload.id : ""),
          payload.id ? "PUT" : "POST",
          payload,
        );
        close();
        await refresh(true);
        notify("配置已保存");
      } finally {
        delete form.dataset.saving;
        inputs.forEach((x, i) => (x.disabled = disabled[i]));
        if (form.isConnected) updateCatalog();
      }
    }
    async function mutation(control, operation) {
      const id = control.dataset.id;
      if (pending.has(id)) return;
      pending.set(id, {
        action: control.dataset.action,
        rowId: control.dataset.row || "",
      });
      host.render();
      try {
        await operation(cardById(id));
        await refresh(true);
      } finally {
        pending.delete(id);
        host.render();
      }
    }
    function chart(counts, distribution, full = false) {
      const sum = counts.reduce((a, b) => a + b, 0) || 1,
        base = distribution.reduce((a, b) => a + b, 0) || 1;
      const numbers = Array.from({ length: 355 }, (_, i) => i).filter(
        (i) => full || counts[i] || distribution[i],
      );
      const max = Math.max(
        0.1,
        Math.ceil(
          Math.max(
            ...numbers.map((i) =>
              Math.max(counts[i] / sum, distribution[i] / base),
            ),
          ) * 10,
        ) / 10,
      );
      const step = 710 / (numbers.length || 1),
        bar = Math.min(20, step * 0.32);
      return `<svg class="fp-chart" viewBox="0 0 760 220" role="img" aria-label="${t("本批与参考基准频率双柱图")}">${[0, 1, 2, 3].map((n) => `<line class="grid" x1="40" x2="750" y1="${15 + n * 55}" y2="${15 + n * 55}"></line><text x="33" y="${18 + n * 55}" text-anchor="end">${Math.round(max * (1 - n / 3) * 100)}%</text>`).join("")}${numbers
        .map((i, n) => {
          const x = 40 + step * (n + 0.5),
            p = counts[i] / sum,
            q = distribution[i] / base;
          return `<g><title>${i + 1} · ${t("本批")} ${(p * 100).toFixed(2)}% · ${t("基准")} ${(q * 100).toFixed(2)}%</title><rect class="reference" x="${x - bar - 1}" y="${180 - (q / max) * 165}" width="${bar}" height="${(q / max) * 165}"></rect><rect class="sample" x="${x + 1}" y="${180 - (p / max) * 165}" width="${bar}" height="${(p / max) * 165}"></rect>${!full || i === 0 || i === 354 || (i + 1) % 30 === 0 ? `<text x="${x}" y="203" text-anchor="middle">${i + 1}</text>` : ""}</g>`;
        })
        .join("")}</svg>`;
    }
    function chartLegend() {
      return `<div class="fp-chartlegend"><span><i class="ref"></i>${t("固定参考基准")}</span><span><i></i>${t("本批有效样本")}</span></div>`;
    }
    async function detail(id) {
      const r = await api("fingerprint-batches/" + id);
      detailBatch = r;
      const max = Math.max(...r.counts),
        modes = r.counts.flatMap((n, i) => (n === max && max ? [i + 1] : [])),
        unique = r.counts.filter(Boolean).length;
      modal(
        "采样批次详情",
        "历史快照 · 只读 · " + time(r.at),
        `<div class="fp-result">${r.score === null ? `<span class="fp-unscored">${t("未评分")}</span><span class="fp-reason">${e(reason(r.reason))}</span>` : `<strong class="fp-score">${r.score.toFixed(1)}<small>/100</small></strong>`}<span>${t("指纹匹配度")}</span></div><div class="detailblock">${e(r.row.name)} · ${e(r.row.target)} · ${e(r.row.effort || t("默认"))}<br>${t("固定参考基准")}：${e(r.baseline.name)} · ${r.baseline.id.slice(0, 8)}<p class="note">${e(r.baseline.source)}</p></div><div class="fp-statgrid"><div><small>${t("有效样本")}</small><strong>${r.valid}/${r.attempted}</strong></div><div><small>${t("样本有效率")}</small><strong>${r.attempted ? Math.round((r.valid / r.attempted) * 100) : 0}%</strong></div><div><small>${t("调用成功")}</small><strong>${r.success}/${r.attempted}</strong></div><div><small>${t("耗时")}</small><strong>${r.finishedAt ? ((r.finishedAt - r.at) / 60000).toFixed(1) : "—"} min</strong></div></div><p class="note">${t("众数")} ${modes.join(", ") || "—"} · ${t("唯一值数量")} ${unique} · ${t("无效样本")} ${r.attempted - r.valid}</p><div class="flex between"><h3>数字频率分布</h3><label><input type="checkbox" data-fp-change="full"> ${t("完整 1–355")}</label></div>${chartLegend()}<div id="fp-chart">${chart(r.counts, r.baseline.distribution)}</div><p class="note">仅显示任一方非零数字，按数字升序；悬停查看频率，不比较原始次数。</p><details class="fp-details"><summary>${t("逐次采样明细")}</summary><div class="buttonrow">${b("读取采样明细", "fp-samples", `data-batch="${r.id}" data-page="1"`, "small")}</div><div id="fp-samples" class="fp-samples"></div></details><details class="fp-details"><summary>${t("配置与 CLI 信息")}</summary><pre>${e(JSON.stringify({ snapshot: r.snapshot, row: r.row, protocol: r.protocol, prompt: samplingProtocolText, method: r.method, baseline: r.baseline, actualModel: null, actualEffort: null, temperature: null, seed: null, outputLimitEnforced: false }, null, 2))}</pre></details><p class="fp-note">实验性分布对照，不代表模型身份、掺混比例或能力。API 参考与 CLI 的可比性尚未验证。</p>`,
      );
    }
    const samplingProtocolText =
      "请从1到355中选择一个数字。只输出这个数字，不要输出任何其他内容。不要调用工具。";
    const sampleStatus = (s) =>
      `${e(t({ success: "调用成功", error: "调用失败", timeout: "请求超时", interrupted: "执行中断" }[s.call] || s.call))}<br>${e(t({ format: "格式无效", tools: "工具调用 · 无效", call: "调用失败" }[s.invalid] || "有效"))}`;
    async function samples(control) {
      control.disabled = true;
      try {
        const id = control.dataset.batch,
          page = Number(control.dataset.page || 1),
          result = await api(`fingerprint-batches/${id}/samples?page=${page}`);
        if (!$("#fp-samples") || detailBatch?.id !== id) return;
        $("#fp-samples").innerHTML =
          `<table class="fp-table"><thead><tr><th>#</th><th>${t("状态")}</th><th>${t("原始回答")}</th><th>${t("耗时")}</th></tr></thead><tbody>${result.items.map((s, i) => `<tr><td>${(page - 1) * 50 + i + 1}</td><td>${sampleStatus(s)}</td><td><pre>${e(s.raw || s.error || "—")}</pre><details><summary>CLI</summary><pre>${e(JSON.stringify({ cli: s.cli, usage: s.usage, error: s.error }, null, 2))}</pre></details></td><td>${((s.finishedAt - s.at) / 1000).toFixed(1)} s</td></tr>`).join("")}</tbody></table><div class="buttonrow"><small>${result.total} · ${page}/${Math.max(1, Math.ceil(result.total / 50))}</small>${b("← 上一页", "fp-samples", `data-batch="${id}" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}`)}${b("下一页 →", "fp-samples", `data-batch="${id}" data-page="${page + 1}" ${page * 50 >= result.total ? "disabled" : ""}`)}</div>`;
      } finally {
        control.disabled = false;
      }
    }
    function history(control) {
      const id = control.dataset.id,
        page = Number(control.dataset.page || 1),
        card = cardById(id),
        f = setting(id),
        rows = state()
          .fingerprintBatches.filter(
            (r) =>
              r.objectId === id &&
              (f.days === "all" ||
                r.at >= state().now - Number(f.days) * 86400000) &&
              (!f.current ||
                card.rows.some(
                  (row) =>
                    row.id === r.rowId && row.historyKey === r.historyKey,
                )),
          )
          .sort((a, z) => z.at - a.at);
      modal(
        "指纹批次历史",
        f.current ? "仅当前配置" : "包含已移除模型与全部配置 · 每页 100 批",
        `<div class="fp-filters"><select data-fp-change="history-range" data-id="${id}" aria-label="${e(card.name)} ${t("历史范围")}">${[
          ["7", "最近 7 天"],
          ["30", "最近 30 天"],
          ["all", "全部保留历史"],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${f.days === value ? "selected" : ""}>${t(label)}</option>`,
          )
          .join(
            "",
          )}</select>${b(f.current ? "仅当前配置" : "全部配置", "fp-history-scope", `data-id="${id}"`, "small")}</div><div class="historylist">${
          rows
            .slice((page - 1) * 100, page * 100)
            .map((r) =>
              b(
                `${time(r.at)} · ${e(r.name)} · ${e(r.effort)} · ${r.score === null ? e(reason(r.reason)) : r.score.toFixed(1)} · ${r.valid}/${r.attempted}`,
                "fp-batch",
                `data-batch="${r.id}"`,
                "historyrecord",
              ),
            )
            .join("") || t("暂无记录")
        }</div><div class="buttonrow">${b("← 上一页", "fp-history", `data-id="${id}" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}`)}${b("下一页 →", "fp-history", `data-id="${id}" data-page="${page + 1}" ${page * 100 >= rows.length ? "disabled" : ""}`)}</div>`,
      );
    }
    function library() {
      modal(
        "参考基准库",
        "固定版本 · 来源不等于厂商认证",
        `<p class="fp-note">预置数据来自 API 采样，与 Codex CLI 的可比性尚未验证。归档不影响已有引用。</p>${state()
          .baselines.map(
            (r) =>
              `<div class="fp-baseline"><div><h3>${e(r.name)} ${r.archived ? `<span class="tag">${t("已归档")}</span>` : ""}</h3><p>${e(r.source)}</p><p>${t("采集时间")} ${e(r.collectedAt || t("未知"))} · ${t("样本数")} ${e(r.sampleCount ?? t("未知"))} · ${r.id.slice(0, 8)}</p><p>${e(r.license)}</p></div><div class="flex">${b("预览", "fp-reference", `data-ref="${r.id}"`, "small")}${b(r.archived ? "恢复" : "归档", "fp-archive", `data-ref="${r.id}"`, "plain small")}</div></div>`,
          )
          .join(
            "",
          )}<div class="divider"></div><h3>导入基准 JSON</h3><p class="note">兼容 hlwy-ai-checker 导出的对象数组；相同内容复用，不覆盖已有绑定。</p><label class="fp-field">${t("选择 JSON 文件")}<input type="file" id="fp-import-file" accept=".json,application/json"></label><textarea id="fp-import" class="fp-import" aria-label="${t("基准 JSON")}" placeholder='[{"name":"…","model":"…","iterations":100,"distribution":[…]}]'></textarea><p id="formerror" class="modalerror" role="alert"></p><div class="buttonrow">${b("导入 JSON", "fp-import", "", "primary")}</div>`,
      );
    }
    async function preview(id) {
      baselinePreview = await api("baselines/" + id);
      const r = baselinePreview;
      modal(
        "参考基准预览",
        r.id.slice(0, 8),
        `<h3>${e(r.name)}</h3><p class="note">${e(r.source)} · ${e(r.license)}</p><p class="note">${t("样本数")} ${e(r.sampleCount ?? t("未知"))} · ${t("采集时间")} ${e(r.collectedAt || t("未知"))}</p>${chart(Array(355).fill(0), r.distribution)}<div class="buttonrow">${b("返回基准库", "fp-library")}</div>`,
      );
    }
    const actions = {
      "fp-new-legacy": () => host.editLegacy(),
      "fp-new": () => {
        edit();
        void host.refreshCatalog();
      },
      "fp-edit": (c) => {
        edit(c.dataset.id);
        void host.refreshCatalog();
      },
      "fp-catalog": () => host.refreshCatalog(),
      "fp-save": save,
      "fp-add": () => {
        collect();
        editing.rows.push(newRow());
        edit(null, true);
      },
      "fp-remove": (c) => {
        collect();
        editing.rows.splice(Number(c.dataset.index), 1);
        edit(null, true);
      },
      "fp-up": (c) => {
        collect();
        const i = Number(c.dataset.index);
        [editing.rows[i - 1], editing.rows[i]] = [
          editing.rows[i],
          editing.rows[i - 1],
        ];
        edit(null, true);
      },
      "fp-filter": (c) => {
        typeFilter = c.dataset.filter;
        host.render();
      },
      "fp-history-scope": (c) => {
        setting(c.dataset.id).current = !setting(c.dataset.id).current;
        history(c);
      },
      "fp-run": (c) =>
        mutation(c, async (o) => {
          await api(
            `objects/${o.id}/run`,
            "POST",
            c.dataset.row ? { rowId: c.dataset.row } : {},
          );
          notify("已加入串行执行队列");
        }),
      "fp-schedule": (c) =>
        mutation(c, (o) =>
          api("objects/" + o.id, "PUT", { ...o, enabled: !o.enabled }),
        ),
      "fp-stop": (c) =>
        modal(
          "停止本轮？",
          "仅影响此卡片",
          `<p>保留已完成模型结果；未完成批次标为中断，未开始模型不生成记录。</p><p class="warning">停止 CLI 不保证供应商停止执行或停止计费。</p><div class="buttonrow">${b("取消", "close")}${b("停止本轮", "fp-confirm-stop", `data-id="${c.dataset.id}"`, "primary")}</div>`,
        ),
      "fp-confirm-stop": (c) =>
        mutation(c, async (o) => {
          await api(`objects/${o.id}/stop`, "POST", {});
          close();
        }),
      "fp-delete": (c) =>
        modal(
          "删除整卡及历史？",
          "此操作不能撤销",
          `<p>删除本卡片、所有模型行、批次与采样明细，并停止其任务。不删除共享基准。</p><div class="buttonrow">${b("取消", "close")}${b("确认删除", "fp-confirm-delete", `data-id="${c.dataset.id}"`, "primary")}</div>`,
        ),
      "fp-confirm-delete": (c) =>
        mutation(c, async (o) => {
          await api("objects/" + o.id, "DELETE");
          close();
        }),
      "fp-batch": (c) => detail(c.dataset.batch),
      "fp-samples": samples,
      "fp-history": history,
      "fp-library": library,
      "fp-reference": (c) => preview(c.dataset.ref),
      "fp-archive": async (c) => {
        c.disabled = true;
        try {
          await api("baselines/" + c.dataset.ref, "PUT", {
            archived: !baselineById(c.dataset.ref).archived,
          });
          await refresh(true);
          library();
        } finally {
          c.disabled = false;
        }
      },
      "fp-import": async (c) => {
        c.disabled = true;
        try {
          await api("baselines", "POST", JSON.parse($("#fp-import").value));
          await refresh(true);
          library();
          notify("基准已导入，已有绑定不变");
        } finally {
          c.disabled = false;
        }
      },
    };
    document.addEventListener("change", async (event) => {
      const c = event.target;
      if (c.dataset.fpChange === "history-range") {
        setting(c.dataset.id).days = c.value;
        history(c);
      }
      if (c.dataset.fpChange === "full" && detailBatch)
        $("#fp-chart").innerHTML = chart(
          detailBatch.counts,
          detailBatch.baseline.distribution,
          c.checked,
        );
      if (c.id === "fp-import-file" && c.files[0]) {
        if (c.files[0].size > 500000) {
          notify("请求过大");
          return;
        }
        const value = await c.files[0].text();
        if ($("#fp-import")) $("#fp-import").value = value;
      }
    });
    document.addEventListener("input", (event) => {
      if (event.target.closest("#fp-form") && !$("#fp-form").dataset.saving) {
        collect();
        $("#fp-cost").innerHTML = cost();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.isComposing &&
        event.target.closest("#fp-form") &&
        event.target.matches('input:not([type="checkbox"])')
      ) {
        event.preventDefault();
        $("[data-action=fp-save]").click();
      }
    });
    return {
      actions,
      choose,
      toolbar,
      card,
      updateCatalog,
      languageChanged: () => {
        if (!$("#fp-form") || !$("#overlay").classList.contains("open"))
          return false;
        collect();
        edit(null, true);
        return true;
      },
      showLegacy: () => typeFilter !== "fingerprint",
      cards: () =>
        typeFilter === "legacy" ? "" : state().fingerprints.map(card).join(""),
      notice: () =>
        state().fingerprints.length
          ? '<p class="fp-note">实验性分布对照，不代表模型身份、掺混比例或能力。API 参考与 CLI 的可比性尚未验证。</p>'
          : "",
    };
  };
})();
