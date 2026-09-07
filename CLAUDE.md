# CLAUDE.md — pi-agent 协作规则

> 本文件是仓库的协作约定，每次会话自动加载。与 SPEC.md §4 的提交规范保持一致。

## 语言约定（最高优先级）

- **commit message 使用中文**：`{feat,fix,docs}[阶段]: <中文描述>`，正文附测试结果（例如 `feat(A1): 添加 openai-responses 传输`）。
- **文件内注释优先使用中文**：代码注释、文档（markdown）统一用中文；团队内部沟通同理。
- **注释符合 JSDoc 规范**：文件头与声明级注释（函数/类型/接口/导出）一律用 `/** ... */` 标准 JSDoc（有参数时写 `@param`/`@returns`）；代码内的解释性注释也写成单行 `/** ... */`，不混用 `//` 行注释。
- 例外：**标识符、API 命名、命令行输出、配置键名**仍用英文（保持代码可读性与生态一致）；用户明确要求英文时才用英文。

## 工作方式（遵循 SPEC §4）

- 一次只做一个任务：读该任务规格 → 写代码 → 写测试 → 跑通 → 展示结果 → commit。不留「测试后补」。
- **git 提交需用户确认**：`npm run check` 与测试通过、展示结果后，等用户明确确认再 `git commit` / `git push`；未经确认不执行任何 git 写入操作。
- 测试与代码同 commit；三层测试（unit / integration / e2e），e2e 仅在环境允许时激活。
- 阶段出口是质量门：`npm run check` 未全绿不进下一阶段。
- 不做 SPEC 未要求的改动（不加功能、不重构、不顺手改无关文件）。
- 注释/文档使用中文表达意图，代码本身保持简洁。

## 工程约束（由 SPEC 与 A1 定死）

- 仅 erasable TypeScript 语法（禁 `enum`/`namespace`/`module`/`import =`/参数属性）。
- 直接依赖精确 pin（`.npmrc` `save-exact` + `check:pinned-deps` 强制）。
- 提交前 `npm run check` 必须全绿（husky pre-commit 已强制，不要跳过）。
- `models.generated.ts` 只经生成脚本修改，手工改动会被 check 拒绝。
