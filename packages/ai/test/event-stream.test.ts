/**
 * 事件流折叠（fold）语义测试：done/error 折叠成最终 AssistantMessage，
 * 异步迭代顺序与终止，push-after-end 忽略。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function makeMessage(partial?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...partial,
	};
}

test("done 事件折叠为最终消息", async () => {
	const stream = new AssistantMessageEventStream();
	const final = makeMessage({ stopReason: "stop" });
	stream.push({ type: "start", partial: makeMessage({ content: [] }) });
	stream.push({ type: "done", reason: "stop", message: final });
	const result = await stream.result();
	assert.equal(result, final);
	assert.equal(result.stopReason, "stop");
});

test("error 事件折叠为带错误信息的事件", async () => {
	const stream = new AssistantMessageEventStream();
	const error = makeMessage({ stopReason: "error", errorMessage: "boom" });
	stream.push({ type: "error", reason: "error", error });
	const result = await stream.result();
	assert.equal(result, error);
	assert.equal(result.errorMessage, "boom");
});

test("异步迭代按 push 顺序产出事件并在 done 后终止", async () => {
	const stream = new AssistantMessageEventStream();
	const final = makeMessage();
	const types: string[] = [];
	const iteration = (async () => {
		for await (const event of stream) types.push(event.type);
	})();
	stream.push({ type: "start", partial: makeMessage({ content: [] }) });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: makeMessage() });
	stream.push({ type: "done", reason: "stop", message: final });
	await iteration;
	assert.deepEqual(types, ["start", "text_delta", "done"]);
});

test("end 之后 push 被忽略，result 已先解析", async () => {
	const stream = new AssistantMessageEventStream();
	const final = makeMessage();
	stream.push({ type: "done", reason: "stop", message: final });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "late", partial: makeMessage() });
	const result = await stream.result();
	assert.equal(result, final);
	const collected: AssistantMessageEvent[] = [];
	for await (const event of stream) collected.push(event);
	assert.equal(collected.length, 1);
});

test("end(result) 显式提供最终结果", async () => {
	const stream = new AssistantMessageEventStream();
	const final = makeMessage();
	stream.end(final);
	assert.equal(await stream.result(), final);
});
