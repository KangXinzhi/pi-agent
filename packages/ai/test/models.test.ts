/** Models 注册表测试：模型查找、stream 分发折叠、checkAuth。 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { createModels, createProvider } from "../src/models.ts";
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

function provider() {
	return createProvider({
		id: "openai",
		name: "OpenAI",
		auth: { type: "api_key", name: "OpenAI API key", envVars: ["OPENAI_API_KEY"] },
		models: [model],
		api: openAIResponsesApi(),
	});
}

function context(): Context {
	return { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

function sseResponse(events: unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;

after(() => {
	if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

test("getModel 按 id 跨 provider 查找", () => {
	const models = createModels([provider()]);
	assert.equal(models.getModel("gpt-4o-mini")?.id, "gpt-4o-mini");
	assert.equal(models.getModel("nonexistent"), undefined);
	assert.equal(models.getProvider("openai")?.name, "OpenAI");
});

test("models.stream 经 provider 分发并正确折叠（mock fetch + env key）", async () => {
	const models = createModels([provider()]);
	const fetchFn = async () =>
		sseResponse([
			{ type: "response.created", response: { id: "r1" } },
			{ type: "response.output_text.delta", delta: "from models" },
			{ type: "response.completed", response: { id: "r1", status: "completed" } },
		]);
	const message = await models
		.stream(models.getModel("gpt-4o-mini")!, context(), {
			apiKey: "k",
			fetch: fetchFn,
		})
		.result();
	assert.equal(message.stopReason, "stop");
	assert.equal((message.content[0] as { text: string }).text, "from models");
});

test("models.stream 对未注册 provider 的模型发 error 事件", async () => {
	const models = createModels([provider()]);
	const unknown: Model<"openai-responses"> = { ...model, id: "ghost", provider: "ghost" };
	const message = await models.stream(unknown, context()).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /No provider registered/);
});

test("checkAuth：无 key 返回 undefined，有 key 返回 api_key", async () => {
	delete process.env.OPENAI_API_KEY;
	const models = createModels([provider()]);
	assert.equal(await models.checkAuth("openai"), undefined);

	process.env.OPENAI_API_KEY = "sk-test";
	const check = await models.checkAuth("openai");
	assert.deepEqual(check, { type: "api_key", source: "OPENAI_API_KEY" });

	assert.equal(await models.checkAuth("unknown"), undefined);
});
