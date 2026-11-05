/**
 * dsh-cost-ledger — browser half (hand-written `__ModuleLoader__` bundle, no
 * build step, React provided by the host).
 *
 * Adds a 「费用」 tab to the conversation tab bar (slot `conversation.view`,
 * next to 对话 / 轨迹 / 上下文 / 编队) showing:
 *   - KPI band: today / window / month / cache hit rate / sample count
 *   - a stacked daily bar chart (money or tokens), hovering shows the day
 *     breakdown the way the official console does
 *   - a per-model table with a confidence badge per row
 *   - an inline price editor: rows with no price can be filled in place, and
 *     the chart recomputes immediately (prices are applied at read time)
 *
 * Everything comes from the host's loopback-only /api/cost-ledger/* routes.
 */

window.__ModuleLoader__.load({
	id: "@looriann/dsh-cost-ledger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const useState = React.useState;
		const useEffect = React.useEffect;
		const useMemo = React.useMemo;

		const NS = "cost-ledger";
		const API = "/api/cost-ledger";
		const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#eab308", "#ec4899", "#14b8a6", "#f97316"];
		const CONF_LABEL = {
			exact: "手填",
			official: "官方价",
			aggregator: "聚合目录",
			inherited: "继承同模型",
			estimated: "估算",
			unpriced: "未定价"
		};

		//#region css
		const CSS_ID = "dsh-cost-ledger";
		const CSS = [
			".clg-root{padding:20px 24px 40px;max-width:1100px;margin:0 auto;color:var(--dsw-alias-text-primary,#111);font-size:13px;line-height:1.5}",
			".clg-head{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}",
			".clg-title{font-size:18px;font-weight:600;margin:0}",
			".clg-sub{color:var(--dsw-alias-text-tertiary,#888);font-size:12px}",
			".clg-spacer{flex:1}",
			".clg-select,.clg-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-primary,#fff);color:inherit;cursor:pointer}",
			".clg-btn:hover,.clg-select:hover{background:var(--dsw-alias-bg-secondary,#f6f7f9)}",
			".clg-btn-primary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:transparent;color:#fff}",
			".clg-btn-primary:hover{filter:brightness(1.05)}",
			".clg-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}",
			".clg-card{background:var(--dsw-alias-bg-secondary,#f6f7f9);border-radius:10px;padding:12px 14px}",
			".clg-card-label{font-size:12px;color:var(--dsw-alias-text-tertiary,#888)}",
			".clg-card-value{font-size:20px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}",
			".clg-card-note{font-size:11px;color:var(--dsw-alias-text-tertiary,#999);margin-top:2px}",
			".clg-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35);margin-bottom:14px}",
			".clg-banner-text{flex:1}",
			".clg-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid transparent;cursor:pointer}",
			".clg-chip-unpriced{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#b91c1c}",
			".clg-chart-wrap{position:relative;background:var(--dsw-alias-bg-secondary,#f6f7f9);border-radius:10px;padding:10px 8px 4px;margin-bottom:16px}",
			".clg-chart{display:block;width:100%;height:auto}",
			".clg-axis{fill:var(--dsw-alias-text-tertiary,#999);font-size:11px}",
			".clg-grid{stroke:var(--dsw-alias-border-l2,#e5e7eb);stroke-width:1}",
			".clg-bar{cursor:pointer;transition:opacity .12s}",
			".clg-bar:hover{opacity:.82}",
			".clg-empty{color:var(--dsw-alias-text-tertiary,#999);text-align:center;padding:48px 0}",
			".clg-tip{position:absolute;transform:translate(-50%,-100%);background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:10px 12px;font-size:12px;pointer-events:none;white-space:nowrap;z-index:3}",
			".clg-tip-row{display:flex;align-items:center;gap:6px;justify-content:space-between;margin-top:3px}",
			".clg-dot{width:8px;height:8px;border-radius:2px;display:inline-block}",
			".clg-table{width:100%;border-collapse:collapse;font-size:12px}",
			".clg-table th{text-align:left;font-weight:500;color:var(--dsw-alias-text-tertiary,#888);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e7eb);white-space:nowrap}",
			".clg-table td{padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);font-variant-numeric:tabular-nums}",
			".clg-table tr:hover td{background:var(--dsw-alias-bg-secondary,#fafafa)}",
			".clg-model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}",
			".clg-provider{color:var(--dsw-alias-text-tertiary,#999);font-size:11px}",
			".clg-badge{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid transparent;white-space:nowrap}",
			".clg-badge-exact{background:rgba(16,185,129,.14);color:#047857;border-color:rgba(16,185,129,.35)}",
			".clg-badge-official{background:rgba(59,130,246,.14);color:#1d4ed8;border-color:rgba(59,130,246,.35)}",
			".clg-badge-aggregator{background:rgba(148,163,184,.2);color:#475569;border-color:rgba(148,163,184,.4)}",
			".clg-badge-inherited{background:rgba(234,179,8,.16);color:#a16207;border-color:rgba(234,179,8,.4)}",
			".clg-badge-estimated{background:rgba(249,115,22,.14);color:#c2410c;border-color:rgba(249,115,22,.4)}",
			".clg-badge-unpriced{background:rgba(239,68,68,.14);color:#b91c1c;border-color:rgba(239,68,68,.4)}",
			".clg-editor{position:fixed;inset:0;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:40}",
			".clg-panel{width:min(460px,92vw);background:var(--dsw-alias-bg-primary,#fff);border-radius:14px;padding:18px 20px;box-shadow:0 20px 48px rgba(0,0,0,.24)}",
			".clg-panel h3{margin:0 0 4px;font-size:15px}",
			".clg-panel p{margin:0 0 14px;color:var(--dsw-alias-text-tertiary,#888);font-size:12px}",
			".clg-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
			".clg-field label{display:block;font-size:11px;color:var(--dsw-alias-text-tertiary,#888);margin-bottom:4px}",
			".clg-field input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-primary,#fff);color:inherit}",
			".clg-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}",
			".clg-err{color:#b91c1c;font-size:12px;margin-top:10px}",
			".clg-muted{color:var(--dsw-alias-text-tertiary,#999)}"
		].join("\n");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
			const el = document.createElement("style");
			el.setAttribute("data-plugin-css", CSS_ID);
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		//#endregion

		//#region format
		function fmtCny(micro) {
			if (micro == null) return "未定价";
			const yuan = micro / 1e6;
			if (yuan === 0) return "¥0";
			if (Math.abs(yuan) < 0.01) return "¥" + yuan.toFixed(4);
			if (Math.abs(yuan) < 1) return "¥" + yuan.toFixed(3);
			return "¥" + yuan.toFixed(2);
		}
		function fmtTokens(n) {
			const v = Number(n) || 0;
			if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + "M";
			if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + "K";
			return String(v);
		}
		function pct(v) {
			return (Number(v) || 0) * 100;
		}
		function moneyOf(day) {
			return day.micro / 1e6;
		}
		//#endregion

		//#region api
		async function apiGet(path) {
			const res = await fetch(API + path, { headers: { accept: "application/json" }, credentials: "same-origin" });
			if (!res.ok) {
				let detail = "";
				try {
					detail = (await res.json()).error || "";
				} catch {
					/* ignore */
				}
				throw new Error("接口错误 " + res.status + (detail ? "：" + detail : ""));
			}
			return res.json();
		}
		async function apiSend(method, path, body) {
			const res = await fetch(API + path, {
				method,
				headers: { "content-type": "application/json", accept: "application/json" },
				credentials: "same-origin",
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "请求失败 " + res.status);
			return data;
		}
		//#endregion

		//#region pieces
		function KpiCard(props) {
			return h(
				"div",
				{ className: "clg-card" },
				h("div", { className: "clg-card-label" }, props.label),
				h("div", { className: "clg-card-value" }, props.value),
				props.note ? h("div", { className: "clg-card-note" }, props.note) : null
			);
		}

		function Badge({ confidence }) {
			const key = confidence || "unpriced";
			return h("span", { className: "clg-badge clg-badge-" + key }, CONF_LABEL[key] || key);
		}

		function Chart({ days, metric, onEdit }) {
			const [hover, setHover] = useState(null);
			const width = 760;
			const height = 230;
			const pad = { l: 52, r: 14, t: 14, b: 30 };
			const innerW = width - pad.l - pad.r;
			const innerH = height - pad.t - pad.b;

			const modelKeys = useMemo(() => {
				const keys = [];
				for (const day of days) {
					for (const bucket of day.byModel) {
						const key = bucket.provider + "/" + bucket.model;
						if (!keys.includes(key)) keys.push(key);
					}
				}
				return keys;
			}, [days]);

			if (!days || days.length === 0) return h("div", { className: "clg-empty" }, "还没有数据：发一条消息后回来看看");

			const valueOf = (day) => (metric === "money" ? moneyOf(day) : day.tokens.total);
			const max = Math.max(...days.map(valueOf), metric === "money" ? 0.01 : 1);
			const step = innerW / days.length;
			const barW = Math.min(46, step * 0.62);
			const colorOf = (key) => PALETTE[Math.max(0, modelKeys.indexOf(key)) % PALETTE.length];
			const ticks = [0, 0.25, 0.5, 0.75, 1];

			const hovered = hover == null ? null : days[hover];

			return h(
				"div",
				{ className: "clg-chart-wrap" },
				h(
					"svg",
					{ className: "clg-chart", viewBox: "0 0 " + width + " " + height, role: "img" },
					ticks.map((t) => {
						const y = pad.t + innerH - innerH * t;
						return h(
							"g",
							{ key: "tick" + t },
							h("line", { className: "clg-grid", x1: pad.l, x2: width - pad.r, y1: y, y2: y }),
							h(
								"text",
								{ className: "clg-axis", x: pad.l - 8, y: y + 4, textAnchor: "end" },
								metric === "money" ? "¥" + (max * t).toFixed(max * t >= 1 ? 1 : 3) : fmtTokens(max * t)
							)
						);
					}),
					days.map((day, i) => {
						const x = pad.l + step * i + (step - barW) / 2;
						let cursor = 0;
						const stack = day.byModel.map((bucket) => {
							const key = bucket.provider + "/" + bucket.model;
							const value = metric === "money" ? bucket.micro / 1e6 : bucket.tokens.total;
							return { key, value, color: colorOf(key) };
						});
						const totalValue = stack.reduce((sum, s) => sum + s.value, 0);
						return h(
							"g",
							{
								key: day.day,
								onMouseEnter: () => setHover(i),
								onMouseLeave: () => setHover(null),
								style: { cursor: "pointer" }
							},
							stack.map((seg, j) => {
								const segH = max > 0 ? (seg.value / max) * innerH : 0;
								const y = pad.t + innerH - cursor - segH;
								cursor += segH;
								if (segH <= 0) return null;
								return h("rect", {
									key: seg.key + j,
									className: "clg-bar",
									x,
									y,
									width: barW,
									height: Math.max(1, segH),
									fill: seg.color,
									rx: 1.5
								});
							}),
							totalValue <= 0
								? h("rect", { className: "clg-bar", x, y: pad.t + innerH - 2, width: barW, height: 2, fill: "var(--dsw-alias-border-l2,#e5e7eb)" })
								: null,
							h(
								"text",
								{ className: "clg-axis", x: x + barW / 2, y: height - 10, textAnchor: "middle" },
								day.day.slice(5)
							)
						);
					})
				),
				hovered
					? h(
							"div",
							{
								className: "clg-tip",
								style: {
									left: ((pad.l + step * hover + step / 2) / width) * 100 + "%",
									top: ((pad.t + innerH - (valueOf(hovered) / max) * innerH) / height) * 100 - 2 + "%"
								}
							},
							h(
								"div",
								{ style: { display: "flex", gap: 16, justifyContent: "space-between", fontWeight: 600 } },
								h("span", null, hovered.day),
								h("span", null, metric === "money" ? fmtCny(hovered.micro) : fmtTokens(hovered.tokens.total) + " tokens")
							),
							hovered.byModel.slice(0, 6).map((bucket) =>
								h(
									"div",
									{ className: "clg-tip-row", key: bucket.provider + bucket.model },
									h(
										"span",
										{ style: { display: "flex", alignItems: "center", gap: 6 } },
										h("i", { className: "clg-dot", style: { background: colorOf(bucket.provider + "/" + bucket.model) } }),
										h("span", { className: "clg-muted" }, bucket.model)
									),
									h("span", null, metric === "money" ? fmtCny(bucket.micro) : fmtTokens(bucket.tokens.total))
								)
							),
							hovered.unpricedTokens > 0
								? h("div", { className: "clg-tip-row clg-muted" }, "其中 " + fmtTokens(hovered.unpricedTokens) + " tokens 未定价")
								: null
					  )
					: null
			);
		}

		function PriceEditor({ target, existing, onClose, onSaved }) {
			const buckets = (existing && existing.buckets) || {};
			const [form, setForm] = useState({
				input: buckets.input == null ? "" : String(buckets.input),
				cacheRead: buckets.cacheRead == null ? "" : String(buckets.cacheRead),
				cacheWrite: buckets.cacheWrite == null ? "" : String(buckets.cacheWrite),
				output: buckets.output == null ? "" : String(buckets.output),
				note: (existing && existing.note) || ""
			});
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });
			const toNum = (value) => {
				if (value === "" || value == null) return null;
				const n = Number(value);
				return Number.isFinite(n) && n >= 0 ? n : null;
			};

			const save = async () => {
				const input = toNum(form.input);
				const output = toNum(form.output);
				if (input == null || output == null) {
					setError("输入单价与输出单价必须填写（元 / 百万 token）");
					return;
				}
				setBusy(true);
				setError("");
				try {
					await apiSend("PUT", "/prices", {
						provider: target.provider,
						model: target.model,
						buckets: { input, cacheRead: toNum(form.cacheRead), cacheWrite: toNum(form.cacheWrite), output },
						note: form.note
					});
					onSaved();
				} catch (err) {
					setError(err.message || String(err));
				} finally {
					setBusy(false);
				}
			};

			return h(
				"div",
				{ className: "clg-editor", onClick: (e) => e.target === e.currentTarget && onClose() },
				h(
					"div",
					{ className: "clg-panel" },
					h("h3", null, "定价 · " + target.model),
					h("p", null, target.provider + " · 单位：元 / 百万 token。留空的缓存单价按输入价计（偏保守）。"),
					h(
						"div",
						{ className: "clg-fields" },
						h("div", { className: "clg-field" }, h("label", null, "输入"), h("input", { value: form.input, onChange: set("input"), inputMode: "decimal", placeholder: "例如 1" })),
						h("div", { className: "clg-field" }, h("label", null, "输出"), h("input", { value: form.output, onChange: set("output"), inputMode: "decimal", placeholder: "例如 4" })),
						h("div", { className: "clg-field" }, h("label", null, "缓存读（可空）"), h("input", { value: form.cacheRead, onChange: set("cacheRead"), inputMode: "decimal", placeholder: "例如 0.02" })),
						h("div", { className: "clg-field" }, h("label", null, "缓存写（可空）"), h("input", { value: form.cacheWrite, onChange: set("cacheWrite"), inputMode: "decimal", placeholder: "例如 1.25" }))
					),
					h("div", { className: "clg-field", style: { marginTop: 10 } }, h("label", null, "备注"), h("input", { value: form.note, onChange: set("note"), placeholder: "例如：百炼控制台 2026-11-05 核对" })),
					error ? h("div", { className: "clg-err" }, error) : null,
					h(
						"div",
						{ className: "clg-actions" },
						h("button", { className: "clg-btn", onClick: onClose, disabled: busy }, "取消"),
						h("button", { className: "clg-btn clg-btn-primary", onClick: save, disabled: busy }, busy ? "保存中…" : "保存并重算")
					)
				)
			);
		}
		//#endregion

		//#region main view
		function CostLedgerView() {
			const [days, setDays] = useState(7);
			const [metric, setMetric] = useState("money");
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [editing, setEditing] = useState(null);
			const [busy, setBusy] = useState(false);

			const reload = async () => {
				setBusy(true);
				try {
					const next = await apiGet("/summary?days=" + days);
					const prices = await apiGet("/prices");
					const rows = (prices.book && prices.book.rows) || [];
					const merged = {
						...next,
						models: (next.models || []).map((m) => {
							const row = rows.find(
								(r) => String(r.provider) === m.provider && String(r.model) === m.model
							);
							return { ...m, existing: row || null };
						})
					};
					setData(merged);
					setError("");
				} catch (err) {
					setError(err.message || String(err));
				} finally {
					setBusy(false);
				}
			};

			useEffect(() => {
				reload();
			}, [days]);

			const unpriced = (data && data.models ? data.models : []).filter((m) => m.confidence === "unpriced" && m.tokens.total > 0);
			const kpi = (data && data.kpi) || {};

			return h(
				"div",
				{ className: "clg-root" },
				h(
					"div",
					{ className: "clg-head" },
					h("h2", { className: "clg-title" }, "费用"),
					h("span", { className: "clg-sub" }, "按天统计 token 与折算成本 · 价格缺失的模型不会伪装成 ¥0"),
					h("span", { className: "clg-spacer" }),
					h(
						"select",
						{ className: "clg-select", value: days, onChange: (e) => setDays(Number(e.target.value)) },
						[7, 14, 30].map((n) => h("option", { key: n, value: n }, "近 " + n + " 天"))
					),
					h("button", { className: "clg-btn", onClick: reload, disabled: busy }, busy ? "刷新中…" : "刷新")
				),

				error
					? h(
							"div",
							{ className: "clg-banner", style: { background: "rgba(239,68,68,.1)", borderColor: "rgba(239,68,68,.35)" } },
							h("div", { className: "clg-banner-text" }, "接口未就绪：" + error + "（Host 半边没加载？重启 DSH 后重试）")
					  )
					: null,

				h(
					"div",
					{ className: "clg-kpi" },
					h(KpiCard, { label: "今日", value: fmtCny(kpi.todayMicro), note: fmtTokens(kpi.todayTokens) + " tokens" }),
					h(KpiCard, { label: "近 " + days + " 天", value: fmtCny(kpi.windowMicro), note: fmtTokens(kpi.windowTokens) + " tokens" }),
					h(KpiCard, { label: "本月", value: fmtCny(kpi.monthMicro), note: fmtTokens(kpi.monthTokens) + " tokens" }),
					h(KpiCard, { label: "缓存命中", value: pct(kpi.cacheHitRate).toFixed(1) + "%", note: "输入侧缓存读占比" }),
					h(KpiCard, { label: "样本", value: String(kpi.samples || 0), note: "每条 = 一个模型步骤" })
				),

				unpriced.length > 0
					? h(
							"div",
							{ className: "clg-banner" },
							h("div", { className: "clg-banner-text" }, "有 " + unpriced.length + " 个模型还没定价，共 " + fmtTokens(unpriced.reduce((s, m) => s + m.tokens.total, 0)) + " tokens 未计入金额。点一下补价："),
							...unpriced.slice(0, 3).map((m) =>
								h(
									"span",
									{
										key: m.provider + m.model,
										className: "clg-chip clg-chip-unpriced",
										onClick: () => setEditing({ provider: m.provider, model: m.model, existing: m.existing })
									},
									"¥ 填价：" + m.model
								)
							)
					  )
					: null,

				h(
					"div",
					{ style: { display: "flex", gap: 8, marginBottom: 8, alignItems: "center" } },
					h("button", { className: "clg-btn" + (metric === "money" ? " clg-btn-primary" : ""), onClick: () => setMetric("money") }, "金额"),
					h("button", { className: "clg-btn" + (metric === "tokens" ? " clg-btn-primary" : ""), onClick: () => setMetric("tokens") }, "tokens"),
					h("span", { className: "clg-spacer" }),
					h(
						"span",
						{ className: "clg-sub" },
						"标价仅供参考；未定价模型不计入金额"
					)
				),

				h(Chart, { days: (data && data.days) || [], metric }),

				h(
					"table",
					{ className: "clg-table" },
					h(
						"thead",
						null,
						h(
							"tr",
							null,
							h("th", null, "模型"),
							h("th", null, "输入"),
							h("th", null, "缓存读"),
							h("th", null, "输出"),
							h("th", null, "合计"),
							h("th", null, "成本"),
							h("th", null, "价格来源"),
							h("th", null, "")
						)
					),
					h(
						"tbody",
						null,
						((data && data.models) || []).length === 0
							? h("tr", null, h("td", { colSpan: 8, className: "clg-empty" }, "近 " + days + " 天没有调用记录"))
							: data.models.map((m) =>
									h(
										"tr",
										{ key: m.provider + m.model },
										h(
											"td",
											null,
											h("div", { className: "clg-model" }, m.model),
											h("div", { className: "clg-provider" }, m.provider)
										),
										h("td", null, fmtTokens(m.tokens.input)),
										h("td", null, fmtTokens(m.tokens.cacheRead)),
										h("td", null, fmtTokens(m.tokens.output)),
										h("td", null, fmtTokens(m.tokens.total)),
										h("td", null, m.confidence === "unpriced" ? h("span", { className: "clg-muted" }, "—") : fmtCny(m.micro)),
										h("td", null, h(Badge, { confidence: m.confidence })),
										h(
											"td",
											null,
											h(
												"button",
												{
													className: "clg-btn",
													onClick: () => setEditing({ provider: m.provider, model: m.model, existing: m.existing })
												},
												m.confidence === "unpriced" ? "补价" : "改价"
											)
										)
									)
							  )
					)
				),

				editing
					? h(PriceEditor, {
							target: editing,
							existing: editing.existing,
							onClose: () => setEditing(null),
							onSaved: () => {
								setEditing(null);
								reload();
							}
					  })
					: null
			);
		}
		//#endregion

		/** @param {any} ctx client root context */
		function apply(ctx) {
			ensureCss();
			ctx.effect(() => ctx.locale.register(NS, { zh: { tab: "费用" }, en: { tab: "Cost" } }), "cost-ledger: dictionaries");
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: NS,
						order: 40,
						locale: NS,
						label: () => "费用"
					},
					CostLedgerView
				)
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.CostLedgerView = CostLedgerView;
		return module.exports;
	}
});