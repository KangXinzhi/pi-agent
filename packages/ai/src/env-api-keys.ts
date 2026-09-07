import type { ProviderEnv, ProviderId } from "./types.ts";

/**
 * A2 仅 env api-key 认证（SPEC §3.3 决策 4 的最小形态）。
 * 候选环境变量按 provider 映射，请求前由 applyAuth 解析合并。
 */

const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
	openai: ["OPENAI_API_KEY"],
};

/** 该 provider 的候选 API key 环境变量名（无论是否已设置）。 */
export function providerEnvVars(provider: ProviderId): readonly string[] | undefined {
	return PROVIDER_ENV_VARS[provider];
}

/** 查找能提供该 provider API key 的候选环境变量名；无则 undefined。 */
export function findEnvKeys(provider: ProviderId, env?: ProviderEnv): string[] | undefined {
	const envVars = providerEnvVars(provider);
	if (!envVars) return undefined;
	const found = envVars.filter((envVar) => {
		const value = env?.[envVar] ?? process.env[envVar];
		return !!value;
	});
	return found.length > 0 ? found : undefined;
}

/** 从已知环境变量取该 provider 的 API key；未配置返回 undefined。 */
export function getEnvApiKey(provider: ProviderId, env?: ProviderEnv): string | undefined {
	const envKeys = findEnvKeys(provider, env);
	if (!envKeys?.[0]) return undefined;
	return env?.[envKeys[0]] ?? process.env[envKeys[0]] ?? undefined;
}
