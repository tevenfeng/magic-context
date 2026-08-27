window.__ModuleLoader__.load({
	id: "@cortexkit/dsh-magic-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:/Users/fengdingwen/Coding/hermes-projects/magic-context/.dsh-src/deepseek-harness/packages/examples/mc-panel/src/client/McDropNodeView.module.css.mjs
		const css = ".rRMk9W_row{color:var(--dsw-alias-label-tertiary);border-left:2px solid var(--dsw-alias-state-info-primary);align-items:center;gap:6px;padding:3px 10px;font-size:11px;line-height:16px;display:flex}.rRMk9W_glyph{color:var(--dsw-alias-state-info-primary)}.rRMk9W_tag{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-alias-label-secondary)}.rRMk9W_tokens{color:var(--dsw-alias-state-info-primary)}";
		const tagId = "@cortexkit/dsh-magic-context/McDropNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@cortexkit/dsh-magic-context";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var McDropNodeView_module_css_default = {
			"row": "rRMk9W_row",
			"glyph": "rRMk9W_glyph",
			"tag": "rRMk9W_tag",
			"tokens": "rRMk9W_tokens"
		};
		//#endregion
		//#region src/client/McDropNodeView.tsx
		function McDropNodeView({ node, t }) {
			const data = node.data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McDropNodeView_module_css_default.row,
				title: "Magic Context freed this tool output from the context",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McDropNodeView_module_css_default.glyph,
						"aria-hidden": true,
						children: "⧉"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McDropNodeView_module_css_default.label,
						children: t("dropped")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McDropNodeView_module_css_default.tag,
						children: `[dropped §${data.tagId}§]`
					}),
					data.shadowedTokens > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McDropNodeView_module_css_default.tokens,
						children: `−${data.shadowedTokens} tok`
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Dictionary for the Magic Context client surface. */
		const en = { dropped: "Freed from context" };
		const zh = { dropped: "已从上下文释放" };
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "mc";
		const DROP_MARKER_RE = /§(\d+)§/;
		const DROP_PLACEHOLDER_RE = /^\[dropped §(\d+)§\]$/;
		/** Full text of one tool-result message, joined from its content blocks. */
		function toolResultText(event) {
			return event.data.message?.content?.[0]?.content?.map((b) => b.text ?? "").join(" ") ?? "";
		}
		/**
		* One `mc-drop` node per replaced tool output. The meter event starts the
		* node with the token delta; the adjacent replacement finalizes it with the
		* tag id (from the placeholder text) and the render anchor.
		*/
		const mcDropDefinition = {
			kind: "mc-drop",
			target: "chat",
			match: (event) => {
				if (event.type === "mc/drop-meter") {
					const anchorSeq = event.data.shadowedSeqs[0];
					if (typeof anchorSeq !== "number") return null;
					return {
						id: `mc-drop:${anchorSeq}`,
						role: "start"
					};
				}
				if (event.type === "tool/result" && event.surfaceOp?.op === "replace") {
					if (!DROP_PLACEHOLDER_RE.test(toolResultText(event))) return null;
					const anchorSeq = (event.sourceEventSeqs ?? [])[0];
					if (typeof anchorSeq !== "number") return null;
					return {
						id: `mc-drop:${anchorSeq}`,
						role: "update"
					};
				}
				return null;
			},
			start: (_context, match, _reader) => {
				return {
					tagId: 0,
					shadowedTokens: match.event.data?.rawTokens ?? 0
				};
			},
			update: (context, match) => {
				const marker = DROP_MARKER_RE.exec(toolResultText(match.event));
				const tagId = marker === null ? context.state.tagId : Number.parseInt(marker[1] ?? "0", 10);
				return {
					...context.state,
					tagId
				};
			},
			buildViewNode: (context) => {
				let tagId = context.state?.tagId ?? 0;
				let shadowedTokens = context.state?.shadowedTokens ?? 0;
				for (const match of context.matches) if (match.event.type === "mc/drop-meter") shadowedTokens = match.event.data.rawTokens ?? shadowedTokens;
				else if (match.event.type === "tool/result") {
					const marker = DROP_PLACEHOLDER_RE.exec(toolResultText(match.event));
					if (marker !== null) tagId = Number.parseInt(marker[1] ?? "0", 10);
				}
				const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
				const anchor = context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0;
				return {
					key: context.key,
					kind: "mc-drop",
					id: context.id,
					target: "chat",
					anchorSeq: anchor + .02,
					location,
					visibility: "visible",
					data: {
						tagId,
						shadowedTokens
					}
				};
			}
		};
		/** Required services: the drop node seat, its registry, locale dictionaries. */
		const inject = [
			"slots",
			"conversationEvents",
			"locale"
		];
		/**
		* Client plugin body: the drop-record node.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "mc: dictionaries");
			ctx.conversationEvents.register(mcDropDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "mc-drop",
				locale: NS
			}, McDropNodeView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map