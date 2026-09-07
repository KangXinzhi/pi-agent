/**
 * openai-responses 传输层测试：mock fetch 下 SSE 事件流折叠正确、
 * 缺 key 报可读错误、HTTP 错误与 failed 事件映射为 error 事件。
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { stream, streamSimple } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-4o-mini",
	name: "GPT-4o mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function context(messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 0 }]): Context {
	return { messages };
}

/** 把事件对象序列化成 OpenAI Responses SSE 文本。 */
function sseResponse(events: unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function usageEvent(overrides: Record<string, unknown> = {}) {
	return {
		type: "response.completed",
		response: {
			id: "resp_123",
			status: "completed",
			usage: {
				input_tokens: 12,
				output_tokens: 7,
				total_tokens: 19,
				input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
			},
			...overrides,
		},
	};
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;

after(() => {
	if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

test("mock fetch：SSE 文本增量折叠成一条消息（文本、stopReason、usage）", async () => {
	let called = false;
	const fetchFn = async () => {
		called = true;
		return sseResponse([
			{ type: "response.created", response: { id: "resp_123" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{ type: "response.output_text.delta", delta: " world" },
			usageEvent(),
		]);
	};

	const streamInstance = stream(model, context(), { apiKey: "test-key", fetch: fetchFn });
	const events: string[] = [];
	for await (const event of streamInstance) events.push(event.type);
	const message = await streamInstance.result();

	assert.equal(called, true);
	assert.deepEqual(events, ["start", "text_start", "text_delta", "text_delta", "done"]);
	assert.equal(message.content[0].type, "text");
	assert.equal((message.content[0] as { text: string }).text, "Hello world");
	assert.equal(message.stopReason, "stop");
	assert.equal(message.responseId, "resp_123");
	/** input_tokens 减去 cached(4) 与 cache_write(2) = 6。 */
	assert.equal(message.usage.input, 6);
	assert.equal(message.usage.output, 7);
	assert.equal(message.usage.cacheRead, 4);
	assert.equal(message.usage.cacheWrite, 2);
	assert.equal(message.usage.totalTokens, 19);
});

test("缺 API key：stream 发 error 事件（可读信息），不发起 fetch", async () => {
	delete process.env.OPENAI_API_KEY;
	let called = false;
	const streamInstance = stream(model, context(), {
		fetch: async () => {
			called = true;
			throw new Error("should not be called");
		},
	});
	const message = await streamInstance.result();
	assert.equal(called, false);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /No API key for provider "openai"/);
	assert.match(message.errorMessage ?? "", /OPENAI_API_KEY/);
});

test("缺 API key：streamSimple 同步抛可读错误", () => {
	delete process.env.OPENAI_API_KEY;
	assert.throws(() => streamSimple(model, context()), /No API key for provider "openai".*OPENAI_API_KEY/);
});

test("HTTP 错误状态 → error 事件并携带状态码", async () => {
	const fetchFn = async () => new Response('{"error":"invalid_api_key"}', { status: 401 });
	const message = await stream(model, context(), { apiKey: "bad-key", fetch: fetchFn }).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /HTTP 401/);
});

test("response.failed 事件 → error 事件", async () => {
	const fetchFn = async () =>
		sseResponse([
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.failed",
				response: { status: "failed", error: { code: "rate_limit", message: "slow down" } },
			},
		]);
	const message = await stream(model, context(), { apiKey: "test-key", fetch: fetchFn }).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /rate_limit: slow down/);
});

test("incomplete/max_output_tokens → stopReason length", async () => {
	const fetchFn = async () =>
		sseResponse([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_text.delta", delta: "partial" },
			{
				type: "response.incomplete",
				response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		]);
	const message = await stream(model, context(), { apiKey: "test-key", fetch: fetchFn }).result();
	assert.equal(message.stopReason, "length");
	assert.equal((message.content[0] as { text: string }).text, "partial");
});

test("usage 按 model.cost 计算 cost", async () => {
	const fetchFn = async () =>
		sseResponse([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_text.delta", delta: "hi" },
			usageEvent(),
		]);
	const message = await stream(model, context(), { apiKey: "test-key", fetch: fetchFn }).result();
	/** input=6 output=7；$0.15/M 与 $0.6/M。 */
	assert.equal(message.usage.cost.input, (6 * 0.15) / 1e6);
	assert.equal(message.usage.cost.output, (7 * 0.6) / 1e6);
	const { total, input, output, cacheRead, cacheWrite } = message.usage.cost;
	assert.ok(Math.abs(total - (input + output + cacheRead + cacheWrite)) < 1e-12);
});

test("跨 chunk 的 SSE 分片仍能正确解析", async () => {
	/** 把整段 SSE 拆成多个小 chunk，模拟网络分片。 */
	const full = [
		`data: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "frag" })}\n\n`,
		`data: ${JSON.stringify(usageEvent())}\n\n`,
	].join("");
	const chunks = full.match(/.{1,7}/gs) ?? [];
	const streamBody = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
	const fetchFn = async () => new Response(streamBody, { status: 200 });
	const message = await stream(model, context(), { apiKey: "test-key", fetch: fetchFn }).result();
	assert.equal((message.content[0] as { text: string }).text, "frag");
	assert.equal(message.stopReason, "stop");
});
