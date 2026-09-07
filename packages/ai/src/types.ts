/**
 * A2 最小核心类型（SPEC §3.3 的子集）。
 * 只保留当前用到的：统一 Model/Provider/Models 契约、Context、消息与事件流。
 * 工具调用（ToolResultMessage/thinking 事件/compat 细化）留到 B2/B3 再补。
 */

import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi = "openai-responses";
export type Api = KnownApi | (string & {});

export type KnownProvider = "openai";
export type ProviderId = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/** $/M tokens 计费。 */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * 统一模型元数据。思考等级映射（thinkingLevelMap）把 pi 的思考等级
 * 翻译成各厂商取值，A2 不消费，B3 归一化时才用到。
 */
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
}

/** ---- 消息 ---- */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** base64 编码的图片数据。 */
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Unix 毫秒时间戳。 */
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage;

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Context {
	systemPrompt?: string;
	messages: Message[];
}

/** ---- 认证（A2 仅 env api-key） ---- */

/** Provider 级环境覆盖，值优先于 process.env。测试时注入。 */
export type ProviderEnv = Record<string, string>;

export interface Auth {
	type: "api_key";
	name: string;
	/** 依次尝试的候选环境变量名。 */
	envVars: readonly string[];
}

export interface AuthCheck {
	type: "api_key";
	source?: string;
}

/** ---- 请求选项 ---- */

export interface StreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	env?: ProviderEnv;
	/** 可注入的 fetch 实现，默认 globalThis.fetch。测试 mock 用。 */
	fetch?: typeof globalThis.fetch;
	temperature?: number;
	maxTokens?: number;
}

export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
}

/**
 * 一个 API 实现模块的统一契约：`src/api/` 下每个厂商协议导出的
 * stream/streamSimple。lazy 包装与 provider 工厂把它当值传来传去。
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple?(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** ---- Provider / Models（注册表 + 请求入口） ---- */

export interface Provider<TApi extends Api = Api> {
	id: ProviderId;
	name: string;
	auth: Auth;
	models: readonly Model<TApi>[];
	stream(model: Model<TApi>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple?(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;
	getModels(): readonly Model<Api>[];
	/** 跨所有 provider 按模型 id 查找（A2 单 provider，见 SPEC §3.3）。 */
	getModel(id: string): Model<Api> | undefined;
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	/** 检查 provider 是否已配置完整认证（env-only）。 */
	checkAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<AuthCheck | undefined>;
}

/** ---- 事件流协议 ---- */

/**
 * AssistantMessageEventStream 的事件协议。
 * 流先 emit `start`，再发增量，最后以 `done`（成功）或 `error`（失败，
 * 消息带 stopReason "error"/"aborted" 与 errorMessage）收尾。
 * A2 只覆盖文本路径；thinking/toolcall 事件随 B2/B3 加入。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
