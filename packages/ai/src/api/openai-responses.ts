/**
 * OpenAI Responses API 传输层（A2 最小实现）。
 * 原生 fetch 直连 SSE，不依赖 openai SDK，mock 友好；lazy 加载见 openai-responses.lazy.ts。
 * 只处理文本流路径：start → text_start/text_delta → done/error。
 */

import { getEnvApiKey, providerEnvVars } from "../env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamOptions,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/** OpenAI Responses 拒绝 max_output_tokens < 16。 */
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/** SSE 事件 JSON 里我们关心的字段（其余忽略）。 */
interface ResponsesStreamEvent {
	type: string;
	response?: {
		id?: string;
		status?: string;
		error?: { code?: string; message?: string };
		incomplete_details?: { reason?: string };
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			total_tokens?: number;
			input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		};
	};
	delta?: string;
	code?: string;
	message?: string;
}

/**
 * 解析 API key：优先取 options.apiKey，其次走 env 认证；缺失时抛可读错误。
 * @param model 目标模型（用于推导 provider 与候选环境变量名）
 * @param options 请求选项，可注入 apiKey / env
 * @returns 解析到的 API key
 */
function getApiKey(model: Model<Api>, options?: StreamOptions): string {
	const key = options?.apiKey ?? getEnvApiKey(model.provider, options?.env);
	if (key) return key;
	const candidates = providerEnvVars(model.provider);
	const hint = candidates?.length ? candidates.join(" or ") : "a provider-specific API key";
	throw new Error(
		`No API key for provider "${model.provider}". Set the ${hint} environment variable, or pass apiKey.`,
	);
}

/**
 * 把统一消息转成 Responses API 的 input 项。
 * 仅文本路径：user 的字符串/文本片段、assistant 的文本内容（工具消息 B2 再补）。
 * @param context 统一会话上下文
 * @returns Responses API input 项数组
 */
function convertMessages(context: Context): unknown[] {
	const items: unknown[] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("\n");
			if (text) items.push({ role: "user", content: text });
		} else if (message.role === "assistant") {
			const texts = message.content.filter((content) => content.type === "text").map((content) => content.text);
			if (texts.length > 0) {
				items.push({ role: "assistant", content: texts.map((text) => ({ type: "output_text", text })) });
			}
		}
	}
	return items;
}

/**
 * 按 model.cost 单价（$/M tokens）计算 usage 的 cost，就地写入 usage.cost。
 * @param model 目标模型（提供计费单价）
 * @param usage 待填充 cost 的用量对象（副作用：修改 usage.cost）
 */
function computeCost(model: Model<Api>, usage: Usage): void {
	const cost = {
		input: (usage.input * model.cost.input) / 1e6,
		output: (usage.output * model.cost.output) / 1e6,
		cacheRead: (usage.cacheRead * model.cost.cacheRead) / 1e6,
		cacheWrite: (usage.cacheWrite * model.cost.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	usage.cost = cost;
}

/**
 * 把 OpenAI Responses 的响应状态映射为统一 stop reason。
 * @param status 上游响应状态（completed/incomplete/failed/cancelled…）
 * @param incompleteReason incomplete 详情里的原因（如 max_output_tokens）
 * @returns 统一 stop reason
 */
function mapStopReason(status: string | undefined, incompleteReason?: string): StopReason {
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return incompleteReason === "max_output_tokens" ? "length" : "error";
		case "failed":
		case "cancelled":
			return "error";
		default:
			return "stop";
	}
}

/**
 * 确保 output 中已存在文本块，返回其 contentIndex；不存在则创建并发 text_start 事件。
 * @param output 正在累积的 assistant 消息（副作用：可能新增文本块）
 * @param stream 目标事件流
 * @returns 文本块在 content 数组中的下标
 */
function ensureTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
	const existing = output.content.findIndex((block) => block.type === "text");
	if (existing >= 0) return existing;
	const index = output.content.length;
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex: index, partial: output });
	return index;
}

/**
 * 追加一段文本增量：累积到文本块并发 text_delta 事件。
 * @param delta SSE 下发的文本片段
 * @param output 正在累积的 assistant 消息（副作用：文本块追加）
 * @param stream 目标事件流
 */
function appendTextDelta(delta: string, output: AssistantMessage, stream: AssistantMessageEventStream): void {
	const index = ensureTextBlock(output, stream);
	(output.content[index] as { type: "text"; text: string }).text += delta;
	stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
}

/**
 * 终结响应：回填 responseId / usage（含 cost 计算）与 stop reason。
 * 由 response.completed / response.incomplete 事件触发。
 * @param event 终结类 SSE 事件
 * @param output 正在累积的 assistant 消息（副作用：写入元数据）
 * @param model 目标模型（计费单价）
 */
function finalizeResponse(event: ResponsesStreamEvent, output: AssistantMessage, model: Model<Api>): void {
	const response = event.response;
	if (response?.id) output.responseId = response.id;
	if (response?.usage) {
		const inputDetails = response.usage.input_tokens_details;
		const cached = inputDetails?.cached_tokens || 0;
		const cacheWrite = inputDetails?.cache_write_tokens || 0;
		output.usage = {
			/** OpenAI 把缓存与 cache-write 计入 input_tokens，需减去。 */
			input: Math.max(0, (response.usage.input_tokens || 0) - cached - cacheWrite),
			output: response.usage.output_tokens || 0,
			cacheRead: cached,
			cacheWrite,
			totalTokens: response.usage.total_tokens || 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		computeCost(model, output.usage);
	}
	const incompleteReason = response?.incomplete_details?.reason;
	output.stopReason = mapStopReason(response?.status, incompleteReason);
	if (response?.status === "incomplete" && incompleteReason !== "max_output_tokens") {
		output.errorMessage = incompleteReason ? `Response incomplete: ${incompleteReason}` : "Response incomplete";
	}
}

/**
 * 按 SSE 事件类型分发处理；failed / error 事件抛错，由 stream 的 catch 转为 error 事件。
 * @param event 已解析的 SSE 事件
 * @param output 正在累积的 assistant 消息（副作用：文本/元数据更新）
 * @param stream 目标事件流
 * @param model 目标模型
 */
function dispatchSseEvent(
	event: ResponsesStreamEvent,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
): void {
	switch (event.type) {
		case "response.created":
			if (event.response?.id) output.responseId = event.response.id;
			break;
		case "response.output_text.delta":
			if (event.delta) appendTextDelta(event.delta, output, stream);
			break;
		case "response.output_text.done":
			/** 内容已通过 delta 累积，无需处理。 */
			break;
		case "response.completed":
		case "response.incomplete":
			finalizeResponse(event, output, model);
			break;
		case "response.failed": {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(message);
		}
		case "error":
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		default:
			/** 其余事件（response.in_progress 等）忽略。 */
			break;
	}
}

/**
 * 解析一段 SSE 文本块，抽取 data 行；无 data 行返回 undefined。
 * @param block 以 \n\n 分隔的一段 SSE 原始文本
 * @returns 拼接后的 data 内容；无 data 行为 undefined
 */
function parseSseBlock(block: string): { data: string } | undefined {
	const lines = block.split("\n");
	const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
	if (dataLines.length === 0) return undefined;
	return { data: dataLines.join("\n") };
}

/**
 * 处理单段 SSE 事件：解析 JSON 并分发；[DONE] 直接返回。
 * @param raw 一段 SSE 原始文本
 * @param output 正在累积的 assistant 消息
 * @param stream 目标事件流
 * @param model 目标模型
 */
async function handleSseEvent(
	raw: string,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
): Promise<void> {
	const parsed = parseSseBlock(raw);
	if (!parsed) return;
	if (parsed.data === "[DONE]") return;
	const event = JSON.parse(parsed.data) as ResponsesStreamEvent;
	dispatchSseEvent(event, output, stream, model);
}

/**
 * 增量读取 SSE 响应体并逐段处理，抗网络分片（跨 chunk 的 \r\n 也已归一化）。
 * @param body 响应体流
 * @param output 正在累积的 assistant 消息（副作用：文本/usage/stopReason 更新）
 * @param stream 目标事件流
 * @param model 目标模型
 */
async function processSse(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		/** 归一化 \r\n → \n（跨 chunk 的 \r\n 在整段 buffer 上 replace，安全）。 */
		buffer = buffer.replace(/\r\n/g, "\n");
		while (true) {
			const separatorIndex = buffer.indexOf("\n\n");
			if (separatorIndex < 0) break;
			const raw = buffer.slice(0, separatorIndex);
			buffer = buffer.slice(separatorIndex + 2);
			if (raw.trim()) await handleSseEvent(raw, output, stream, model);
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) await handleSseEvent(buffer, output, stream, model);
}

/**
 * OpenAI Responses API 流式调用（A2 文本路径）。
 * 同步返回事件流：错误一律编码为 error 事件而非抛出；成功以 done 事件收尾。
 * @param model 目标模型（provider/baseUrl/cost 决定请求与计费）
 * @param context 统一会话上下文（systemPrompt + 消息列表）
 * @param options 请求选项（apiKey/env/fetch/signal/temperature/maxTokens）
 * @returns AssistantMessageEventStream，可用 result() 折叠出最终消息
 */
export const stream = (
	model: Model<"openai-responses">,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	/** 异步处理：错误一律编码为 error 事件，不抛出。 */
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = getApiKey(model, options);
			const fetchFn = options?.fetch ?? globalThis.fetch;
			const url = `${model.baseUrl.replace(/\/+$/, "")}/responses`;

			const body: Record<string, unknown> = {
				model: model.id,
				input: convertMessages(context),
				stream: true,
				store: false,
			};
			if (context.systemPrompt) body.instructions = context.systemPrompt;
			if (options?.temperature !== undefined) body.temperature = options.temperature;
			if (options?.maxTokens !== undefined) {
				body.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
			}

			const response = await fetchFn(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(
					`OpenAI API error (HTTP ${response.status}): ${(text || response.statusText).slice(0, 500)}`,
				);
			}
			if (!response.body) throw new Error("OpenAI Responses returned an empty body");

			eventStream.push({ type: "start", partial: output });
			await processSse(response.body, output, eventStream, model);

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Unknown error");
			}
			eventStream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
			eventStream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};

/**
 * OpenAI Responses API 简单调用：在 stream 之上做缺 key 的同步校验。
 * 与参考行为一致：缺 key 时同步抛可读错误；stream 则编码为 error 事件。
 * @param model 目标模型
 * @param context 统一会话上下文
 * @param options 请求选项（含可选 reasoning，A2 暂不映射思考等级）
 * @returns AssistantMessageEventStream
 */
export const streamSimple = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	/** 与参考一致：streamSimple 同步抛缺 key 的可读错误；stream 则编码为 error 事件。 */
	getApiKey(model, options);
	return stream(model, context, options);
};
