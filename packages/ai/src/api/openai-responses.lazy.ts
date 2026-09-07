import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** lazy 包装：openai-responses 模块首次 stream 调用时才动态加载。 */
export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.ts"));
