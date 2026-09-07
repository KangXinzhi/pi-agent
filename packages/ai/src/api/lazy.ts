import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/**
 * 懒加载基础设施：让传输模块在首次 stream 调用时才动态加载，
 * 避免启动即拉起所有厂商实现（见 SPEC §3.3 决策 1）。
 */

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * 同步返回流，把异步 setup（认证解析、懒模块加载）藏在流后面跑。
 * setup 失败以 error 事件终止流，而不是抛出。
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * 把动态 import 的 API 实现包装成 ProviderStreams，实现模块级懒加载。
 *
 * - `stream`：底层完整入口，直接接收 Provider 参数，适用于需要精细控制厂商参数的场景；
 *   流式错误统一转换为 error 事件。
 * - `streamSimple`：上层便捷入口，适用于 Agent 循环等通用调用场景；
 *   同步校验必要配置，将 reasoning、toolChoice 等通用语义转换为 Provider 参数后委托给 `stream`。
 *
 * 两者遵循相同的 AssistantMessageEventStream 契约，上层可按场景选择使用。
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => {
				const implementation = await load();
				if (!implementation.streamSimple) {
					throw new Error("API implementation does not support streamSimple");
				}
				return implementation.streamSimple(model, context, options);
			}),
	};

	return api;
}
