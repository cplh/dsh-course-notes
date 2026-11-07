# Changelog

## 1.1.0 — 2026-11-07

- 双格式笔记：每个视频同时生成同名 `<标题>.md` 与 `<标题>.docx`。
- 视频链接置顶：Markdown 与 Word 开头都带 B 站链接（优先解析 coursemap 的 poll.log bvid，失败用 B 站公开搜索反查，仍失败写占位）。
- 新会话提示词同时给出链接与两份文件路径，`present` 同时展示 Markdown + Word。
- `delivered.json` 增加 md / url / bvid；`course_notes_deliver` 返回 md / url。
- 单元测试扩展到 10 个（链接解析、双格式、占位降级、spawn 重试、共享 notesDir 等）。
- 可选 settingsFile / stateDir：本地控制台写入 notesDir 后插件下一轮读取；delivered/status/log 固定在状态目录，切换笔记目录不丢交付记录。

## 1.0.0 — 2026-11-07

- 首个版本：监听 dsh-video-coursemap 的新视频，生成 Word 知识笔记，通过 dsh-memory-evolve 的 de_session 新建会话并写项目记忆。
