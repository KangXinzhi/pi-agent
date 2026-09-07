/** env api-key 解析测试：候选变量映射、注入 env 优先级、未配置时 undefined。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findEnvKeys, getEnvApiKey, providerEnvVars } from "../src/env-api-keys.ts";

test("providerEnvVars 返回候选变量名", () => {
	assert.deepEqual(providerEnvVars("openai"), ["OPENAI_API_KEY"]);
	assert.equal(providerEnvVars("unknown-provider"), undefined);
});

test("getEnvApiKey 从注入 env 取值（测试可注入，不依赖真实 process.env）", () => {
	assert.equal(getEnvApiKey("openai", { OPENAI_API_KEY: "sk-env" }), "sk-env");
});

test("getEnvApiKey 从 process.env 取值", () => {
	const original = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-process";
	try {
		assert.equal(getEnvApiKey("openai"), "sk-process");
	} finally {
		if (original === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = original;
	}
});

test("未配置时返回 undefined", () => {
	const original = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	try {
		assert.equal(getEnvApiKey("openai"), undefined);
		assert.equal(findEnvKeys("openai"), undefined);
		assert.equal(getEnvApiKey("unknown-provider"), undefined);
	} finally {
		if (original !== undefined) process.env.OPENAI_API_KEY = original;
	}
});
