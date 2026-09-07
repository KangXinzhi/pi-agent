/**
 * Provider 工厂 + Models 注册表（SPEC §3.3）。
 * createProvider 只是把 {id, auth, models, api} 组装起来；新增厂商 = 新 api 传输 + 新工厂。
 */

import { lazyStream } from "./api/lazy.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	Auth,
	AuthCheck,
	Context,
	Model,
	Models,
	Provider,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	name?: string;
	auth: Auth;
	models: readonly Model<TApi>[];
	api: ProviderStreams;
}

export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const provider: Provider<TApi> = {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		models: input.models,
		stream: (model, context, options) => input.api.stream(model as Model<Api>, context, options),
		streamSimple: (model, context, options) => {
			if (!input.api.streamSimple) {
				return lazyStream(model as Model<Api>, async () => {
					throw new Error(`Provider ${input.id} does not support streamSimple`);
				});
			}
			return input.api.streamSimple(model as Model<Api>, context, options);
		},
	};
	return provider;
}

export function createModels(providers: readonly Provider[]): Models {
	const providerList = [...providers];
	const allModels = (): Model<Api>[] => providerList.flatMap((provider) => [...provider.models]);

	return {
		getProviders: () => providerList,
		getProvider: (id) => providerList.find((provider) => provider.id === id),
		getModels: () => allModels(),
		getModel: (id) => allModels().find((model) => model.id === id),
		stream: (model, context, options) => {
			const provider = providerList.find((entry) => entry.id === model.provider);
			if (!provider) {
				return lazyStream(model, async () => {
					throw new Error(`No provider registered for "${model.provider}"`);
				});
			}
			return provider.stream(model, context, options);
		},
		checkAuth: async (providerId): Promise<AuthCheck | undefined> => {
			const provider = providerList.find((entry) => entry.id === providerId);
			if (!provider) return undefined;
			const key = getEnvApiKey(providerId);
			if (!key) return undefined;
			return { type: "api_key", source: provider.auth.envVars.find((envVar) => process.env[envVar]) };
		},
	};
}

export type { Auth, AuthCheck, Context, Model, Models, Provider, SimpleStreamOptions, StreamOptions };
