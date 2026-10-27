// Shared overview primitives; monitor types supply data and action semantics.
(() => {
  "use strict";
  globalThis.createMonitorComponents = ({
    button,
    escape: e,
    time,
    t,
    render,
  }) => {
    const capacities = new Map(),
      targets = new Map();
    const observer = new ResizeObserver((entries) => {
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
        if (capacities.get(key) !== slots) {
          capacities.set(key, slots);
          changed = true;
        }
      }
      if (changed) render();
    });
    function bind(root) {
      for (const [line, key] of targets)
        if (!line.isConnected || line.dataset.timeline !== key) {
          observer.unobserve(line);
          targets.delete(line);
        }
      const active = new Set();
      for (const line of root.querySelectorAll(".bars[data-timeline]")) {
        active.add(line.dataset.timeline);
        if (!targets.has(line)) {
          targets.set(line, line.dataset.timeline);
          observer.observe(line);
        }
      }
      for (const key of capacities.keys())
        if (!active.has(key)) capacities.delete(key);
    }
    // Adapters provide newest-first records, independently of storage order.
    function timeline({
      key,
      records,
      cell,
      label,
      emptyText = "所选范围暂无记录",
    }) {
      const slots = capacities.get(key) ?? 0,
        visible = records.slice(0, slots).toReversed(),
        boundaries = visible.filter(
          (r, i) => i > 0 && r.historyKey !== visible[i - 1].historyKey,
        ),
        count = t("展示最近 {shown} 条 / 共 {total} 条")
          .replace("{shown}", visible.length)
          .replace("{total}", records.length);
      return `<div class="timeline"><div class="bars" data-timeline="${e(key)}" role="group" aria-label="${e(label)}">${Array.from(
        { length: slots - visible.length },
        () =>
          `<span class="timeline-empty" title="${e(t("暂无执行记录"))}" aria-hidden="true"></span>`,
      ).join("")}${visible
        .map((r) => {
          const c = cell(r),
            boundary = boundaries.includes(r),
            title = c.title + (boundary ? " · " + t("配置分界") : "");
          return button(
            c.text || "",
            c.action,
            `${c.attrs} title="${e(title)}" aria-label="${e(title)}"`,
            `${c.className || ""}${boundary ? " timeline-boundary" : ""}`,
          );
        })
        .join(
          "",
        )}</div></div><div class="revision-markers">${boundaries.map((r) => `<small>${t("配置变更")} ${time(r.at)}${r.version ? ` · v${r.version}` : ""}</small>`).join("")}</div><div class="axis"><span>${e(count)}</span><span>${records.length ? t("最新") + " " + time(records[0].at) : t(emptyText)}</span></div>`;
    }
    function runButton({
      action,
      attrs,
      single = false,
      submitting = false,
      disabled = false,
    }) {
      return button(
        submitting ? "正在提交…" : single ? "▷ 运行" : "▷ 执行一轮",
        action,
        `${attrs} aria-busy="${submitting}" ${disabled || submitting ? "disabled" : ""}`,
        single ? "plain small" : "primary small",
      );
    }
    function status(kind, text, live = false) {
      return `<span class="status status-${kind}" role="status" ${live ? 'aria-live="polite"' : ""}>${e(t(text))}</span>`;
    }
    function cardActions({
      id,
      status,
      history = "history",
      edit = "edit",
      pending = false,
      toggle,
      execution,
    }) {
      const attrs = `data-id="${e(id)}"`;
      return `<div class="flex card-actions">${status}${button("历史", history, attrs, "small")}${button(toggle.text, toggle.action, `${attrs} aria-busy="${Boolean(toggle.busy)}" title="${e(t(toggle.title))}" ${pending || toggle.disabled ? "disabled" : ""}`, "small")}${button("编辑", edit, `${attrs} ${pending ? "disabled" : ""}`, "small")}${execution}</div>`;
    }
    return { bind, timeline, runButton, status, cardActions };
  };
})();
