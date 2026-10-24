window.__ModuleLoader__.load({
	id: "@martindye/dsh-model-dial",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/Dial.tsx
		/**
		* The dial itself: a 34px progress gauge in the session header.
		*   processing -> amber ring filling with the server's own progress %, % in the middle
		*   compacting -> amber ring at the summary % (generated tokens over the
		*                  summarisation budget), % in the middle; blind slow spin
		*                  while that percent is unknown (the harness summarises
		*                  old context)
		*   otherwise  -> grey ring with a dot (idle, generating, or server down)
		* A small task label ("prompt processing" / "generating" / "compacting")
		* sits to the right while work is active, and nothing when idle.
		* No speeds and no totals on the dial — those already live in the app's bar.
		*/
		const R = 15;
		const CIRC = 2 * Math.PI * R;
		/** A progress line older than this means "no active progress": grey. */
		const LIVE_MS = 3e3;
		function Dial({ status }) {
			const [st, setSt] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let live = true;
				const poll = async () => {
					try {
						const s = await status?.();
						if (live && s) setSt(s);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, 1e3);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, [status]);
			const pct = st?.prefillPercent ?? 0;
			const gauge = st?.phase === "prefill" && st.progressAt !== null && st.progressAt !== void 0 && st.prefillPercent !== null && Date.now() - st.progressAt < LIVE_MS;
			/** Harness summarising the old context (a few minutes of model time). */
			const compacting = st?.compacting === true;
			const compactRaw = st?.compactPercent ?? null;
			const compactPct = typeof compactRaw === "number" && Number.isFinite(compactRaw) ? compactRaw : null;
			/** Compacting with a summary percent: static amber ring, % in the middle. */
			const compactGauge = compacting && !gauge && compactPct !== null;
			/** Compacting without a percent to show: an amber arc circles slowly. */
			const spin = compacting && !gauge && !compactGauge;
			const color = gauge || spin || compactGauge ? "#f59e0b" : "#6b7280";
			const arc = gauge ? Math.min(1, Math.max(.02, pct)) : compactGauge && compactPct !== null ? Math.min(1, Math.max(.02, compactPct)) : 0;
			const center = gauge ? `${Math.round(pct * 100)}%` : compactGauge && compactPct !== null ? `${Math.round(compactPct * 100)}%` : "";
			/** Small task label shown to the right of the ring while work is active. */
			const label = compacting ? "compacting" : gauge ? "prompt processing" : st?.phase === "decode" ? "generating" : "";
			const title = compacting ? compactPct !== null && !gauge ? `Compacting the prompt · summary ${Math.round(compactPct * 100)}%` : "Compacting the prompt (summarising old context)" : gauge ? `Processing prompt · ${Math.round(pct * 100)}%` : st?.phase === "decode" ? "Generating" : st?.phase === "down" ? "Model server unreachable at 127.0.0.1:8080" : "No active processing";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 6,
					lineHeight: 1
				},
				title,
				"data-model-dial": compacting ? "compacting" : gauge ? "progress" : st?.phase ?? "idle",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: 34,
					height: 34,
					viewBox: "0 0 34 34",
					"aria-hidden": "true",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: 17,
							cy: 17,
							r: R,
							fill: "none",
							stroke: "currentColor",
							strokeOpacity: .15,
							strokeWidth: 3
						}),
						arc > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: 17,
							cy: 17,
							r: R,
							fill: "none",
							stroke: color,
							strokeWidth: 3,
							strokeLinecap: "round",
							strokeDasharray: `${CIRC * arc} ${CIRC}`,
							transform: "rotate(-90 17 17)"
						}),
						spin && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: 17,
							cy: 17,
							r: R,
							fill: "none",
							stroke: color,
							strokeWidth: 3,
							strokeLinecap: "round",
							strokeDasharray: `${CIRC * .25} ${CIRC}`
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("animateTransform", {
							attributeName: "transform",
							type: "rotate",
							from: "0 17 17",
							to: "360 17 17",
							dur: "1.4s",
							repeatCount: "indefinite"
						})] }),
						gauge || compactGauge ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
							x: 17,
							y: 17.5,
							textAnchor: "middle",
							dominantBaseline: "middle",
							fontSize: 7.5,
							fill: color,
							children: center
						}) : !spin && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: 17,
							cy: 17,
							r: 3,
							fill: "#6b7280",
							opacity: .6
						})
					]
				}), label !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						fontSize: 8,
						color: "#9ca3af",
						whiteSpace: "nowrap",
						userSelect: "none"
					},
					children: label
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Minimal locale rows for the slot registration. */
		const NS = "dsh-model-dial";
		const en = { "model-dial.name": "Model dial" };
		const zh = { "model-dial.name": "模型仪表盘" };
		//#endregion
		//#region src/client/mount.ts
		const inject = [
			"remote",
			"slots",
			"locale"
		];
		/** Pass-through codec (the bundle has no zod): the runtime only needs the shape. */
		function passThroughCodec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				create: () => ({
					parse: (value) => value,
					safeParse: (value) => ({
						success: true,
						data: value
					})
				})
			};
		}
		const DIAL_REMOTE = {
			package: "@martin/dsh-model-dial",
			descriptors: [{
				id: "@martin/dsh-model-dial#modelDial/status",
				service: "modelDialController",
				namespace: "modelDial",
				method: "status",
				invocation: { kind: "direct" },
				parameters: [],
				result: passThroughCodec("@martin/dsh-model-dial#ModelStatus")
			}]
		};
		/**
		* The typert remote resolves to the result envelope ({ ok, value }), not
		* the bare value — unwrap it (same pattern as the dsh-voice client).
		*/
		function unwrap(status) {
			if (status && typeof status === "object" && "ok" in status) {
				const r = status;
				return r.ok && r.value !== null && typeof r.value === "object" ? r.value : null;
			}
			return status ?? null;
		}
		async function mountDial(ctx) {
			const contribution = DIAL_REMOTE;
			const disposeRemote = await ctx.remote.$mount(contribution);
			const ns = ctx.get("remote.modelDial");
			const ui = ctx.inject(["slots", "locale"], (c) => {
				c.effect(() => c.locale.register(NS, {
					zh,
					en
				}));
				c.slots.inject("conversation.session.header.actions", () => c.slots.register({
					name: "conversation.session.header.actions",
					id: "model-dial",
					order: 900,
					locale: NS,
					inject: () => ({ status: () => Promise.resolve(ns).then((n) => n?.status?.()).then(unwrap).catch(() => null) })
				}, Dial));
			});
			return async () => {
				await ui.dispose();
				await disposeRemote();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Activate the model dial.
		* @param ctx - Client runtime.
		* @returns disposer for the Remote and UI slot.
		*/
		async function apply(ctx) {
			try {
				return await mountDial(ctx);
			} catch (error) {
				console.error("DSH_MODEL_DIAL_APPLY_ERR", error);
				throw error;
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map