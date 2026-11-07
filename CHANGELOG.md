# Changelog

## 1.1.1 — 2026-11-07

- README 重做：收益优先开头、Badge、一键安装、Mermaid 流程图、折叠 FAQ、分类限制。
- 新增应用截图、B 站视频截图与笔记内容预览；补充“你会得到什么”示例。
- 无功能/接口变更，仅文档与发布元数据更新。

## 1.1.0 — 2026-11-07

- 双格式笔记：每个视频同时生成同名 `<标题>.md` 与 `<标题>.docx`。
- 视频链接置顶：Markdown 与 Word 开头都带 B 站链接（优先解析 coursemap 的 poll.log bvid，失败用 B 站公开搜索反查，仍失败写占位）。
- 新会话提示词同时给出链接与两份文件路径，`present` 同时展示 Markdown + Word。
- `delivered.json` 增加 md / url / bvid；`course_notes_deliver` 返回 md / url。
- 单元测试扩展到 10 个（链接解析、双格式、占位降级、spawn 重试、共享 notesDir 等）。
- 可选 settingsFile / stateDir：本地控制台写入 notesDir 后插件下一轮读取；delivered/status/log 固定在状态目录，切换笔记目录不丢交付记录。

## 1.0.0 — 2026-11-07

- 首个版本：监听 dsh-video-coursemap 的新视频，生成 Word 知识笔记，通过 dsh-memory-evolve 的 de_session 新建会话并写项目记忆。
