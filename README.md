# dsh-course-notes

B站课程知识笔记桥（DSH 插件）。监听 dsh-video-coursemap 的产物，把每个新视频整理成同名 Markdown + Word 知识笔记（视频链接置顶），并借助 dsh-memory-evolve 的 de_session 新建会话，在对话框里同时展示两份文件、写入项目记忆。

- 只消费 coursemap 的 state.json / manuals，不重复抓取、不重复调用总结 LLM。
- 双格式：知识笔记/<学科>/<标题>.md 与 <标题>.docx，基础名相同。
- 视频链接：优先从 coursemap 的 poll.log 解析 bvid；失败用 B 站公开搜索反查；仍失败写占位，不阻断交付。
- 新会话由 de_session 创建；de_session 不可用时用 agents.create + followup 兜底。
- 已交付记录持久化；空闲时零 LLM 调用；异常只写日志，不影响 DSH 其他插件。

## 预览

    # 民俗文化 · 纪录片《中国风水文化》100集全

    > 视频链接：https://www.bilibili.com/video/BV1Ss411R7TM
    > 自动生成于 2026/11/7 20:11:29
    > 来源：B站视频课程实时总结（dsh-video-coursemap 抓取简介/字幕/弹幕/评论）
    > 以六千年风水史为线索，从人文、自然与建筑多角度探索中国风水文化的百集纪录片。

    ### 核心知识点
    - **影片定位与叙事线索**
      - 中国第一部全方位涉及风水领域的影片
      - ...

## 前置条件

| 依赖 | 说明 |
|---|---|
| DSH 桌面版 | 实测 0.2.2-rc.1；需要 agents / tools / agentPresets / present |
| Windows 10/11 x64 | coursemap 用 PowerShell + Win32 前台窗口检测；本包声明 os: win32 |
| dsh-video-coursemap 2.0.0 | 视频检测、学科分类、抓取、学习手册 |
| dsh-memory-evolve 0.1.0 | de_session 新建会话 + memory 写笔记；需开启「会话编排」 |
| Python 3 + python-docx | 生成 Word；可用 DSH 捆绑运行时，或配置 pythonPath |
| PowerShell 5.1+ | coursemap 读取前台窗口 |
| LLM provider/model | DSH 中已配置；用于分类、总结与新会话 |
| 网络 | api.bilibili.com、comment.bilibili.com、LLM 接口 |

本包自身零 npm 依赖；上面两个插件是运行前置，不随本包安装。DSH 会自动 install 本包，但不会替你启用 coursemap / memory-evolve 的 bundle，请分别安装并确认它们已启用。

## 安装

1. 安装 DSH 桌面版（Windows），确认 profile 可用。
2. 安装并启用两个前置插件：在 DSH 桌面版「插件 → 市场 / 插件管理」搜索并安装；有 dsh CLI 时也可：
       dsh plugin add https://github.com/linner1224/dsh-video-coursemap/releases/download/v2.0.0/dsh-video-coursemap-2.0.0.tgz
       dsh plugin add github:csyangwen/dsh-memory-evolve
   然后在 memory-evolve 的「记忆 → 会话编排」打开开关。
3. 安装本插件：在「插件 → 市场」搜索 dsh-course-notes；有 dsh CLI 时也可：
       dsh plugin add dsh-course-notes
   桌面版没有 dsh 命令时，用插件页安装即可。
4. 如需自定义路径，按「配置」一节覆盖；然后重启/刷新 DSH。
5. 打开一个 B 站视频（客户端/浏览器前台），调用 course_notes_status 检查链路。

本包已声明 dsh.bundle.patch，安装时会自动插入 dsh-course-notes 插件行；不要同时在 profile patch 里再写一遍 insert（重复 id 会失败）。

## 配置

bundle 安装后，在 profile 的 cordis.patch.yml 里只加配置覆盖：

    - id: dsh-course-notes
      config:
        coursemapOutputDir: 'C:\Users\<you>\课程知识地图'
        outputDir: 'C:\Users\<you>\课程笔记'
        sessionCwd: 'C:\Users\<you>\项目'
        # pythonPath: 'C:\Users\<you>\...\python.exe'

| 键 | 默认 | 说明 |
|---|---|---|
| coursemapOutputDir | ~/课程知识地图 | 必须与 coursemap 的 outputDir 一致 |
| outputDir | ~/课程笔记 | 初始/默认单视频笔记目录；settingsFile.notesDir 可覆盖 |
| sessionCwd | outputDir | 新会话 cwd，也是项目记忆归属；建议设为你的项目目录 |
| pollIntervalMs | 5000 | 差量轮询间隔（≥2000） |
| maxDeliveriesPerPoll | 1 | 每轮最多交付数，防会话风暴 |
| maxAttempts | 3 | 失败重试次数 |
| backfillOnFirstRun | false | 首次启动是否补发历史视频 |
| provider / model / agentPreset | null | 新会话路由覆盖；null = 默认 |
| pythonPath | null | 指定带 python-docx 的 Python；null = 自动扫描 DSH 运行时与 PATH |
| settingsFile | null | 可选共享 JSON（如 course-console/config.json），读取 notesDir；相对路径按 sessionCwd 解析 |
| stateDir | <outputDir>/.state | delivered/status/log 固定状态目录；改 notesDir 时保持不变 |

如果 coursemap 保持默认输出目录，coursemapOutputDir 可省略；sessionCwd 建议显式设置，否则项目记忆会落在 outputDir。

如果用本地控制台（course-console）的「笔记保存目录」，在 profile 配置里加 settingsFile: 'course-console/config.json'；控制台写 notesDir，插件下一轮读取。stateDir 固定，改目录不会丢交付记录。

## 工具

- course_notes_status：查看输出目录、de_session、Python、已交付/待交付/失败计数、最近交付与错误。
- course_notes_deliver：手动补发单个视频；参数 title（必填）、subject（可选）、force（已交付过强制重发）。返回 md/docx/url/sessionId。
- 依赖的 coursemap 工具：course_map_status / course_map_scan（scan 用于手动指定标题测试）。

## 工作原理

1. coursemap 每 15s 读前台窗口；新视频连续稳定后判课程、分学科，抓 B 站简介/字幕/弹幕/评论，生成/更新学习手册 docx，并写 state.json。
2. 本插件每 5s 比较 state.json 的 mtime，用「学科+标题」与 delivered.json 做差量。
3. 新视频：抽取手册中的视频章节 → 解析视频链接 → 写同名 md → md2docx.py 转同名 docx。
4. 调 memory-evolve 的 de_session 新建会话（或兜底 agents.create），提示词带链接、md/docx 路径与“读 md、写 memory、present 两份文件”的指令。
5. 成功写 delivered.json（md/docx/url/bvid/sessionId）；失败重试，最多 maxAttempts 次。

## 排障

- Word 报 No module named 'docx'：coursemap 启动时没找到带 python-docx 的 Python。确认 DSH 运行时存在后重启 DSH，或在配置里显式设置 pythonPath。
- 没有生成笔记：看 课程知识地图/.state/poll.log 是否识别到视频；前台必须是浏览器/视频客户端；标题含「哔哩哔哩」的首页/搜索页会被跳过。
- 没有视频链接：看 poll.log 里是否有 bili content title=... bvid=BV...；没有则插件会走 B 站搜索，仍失败会写占位。可 force 重发或手动补链接。
- 没有新会话：看 知识笔记/.state/delivery.log 与 course_notes_status 的 lastError；de_session 不可用时走兜底 spawn；provider/model 为空会拒绝。
- 重复：delivered.json 以「学科+标题」为键；force=true 才会重发。不要对同一标题反复 course_map_scan（会追加重复章节）。
- 旧笔记只有 docx：历史条目不会自动补 md/链接，用 course_notes_deliver(force=true) 逐条补齐（会新建会话）。
- 配置不生效：确认只改了 id 为 dsh-course-notes 的 config 覆盖，没有重复 insert；保存后 HMR 会重新组合，必要时重启。

## 限制

- Windows-only：依赖 coursemap 的前台窗口检测（PowerShell + Win32）；package.json 已声明 os: win32。
- 只检测前台窗口；后台播放、最小化不会触发。
- B 站匿名接口：评论封顶 3 条、字幕多数没有、偶发 412；链接反查可能因标题歧义失败。
- 新会话需要同进程 de_session；DSH 关闭/跨实例无法程序化唤醒。
- Word 中链接为可复制纯文本；Markdown 中可点击。
- 缺 python-docx 时 Word 失败、交付会重试；当前没有只出 Markdown 的降级模式。
- 每个新视频 1 次分类 + 1 次总结 + 1 个新会话回合；空闲零 LLM。

## 开发

- 开发时可 link 安装：在 profile 目录执行
      pnpm add link:<path-to>/dsh-course-notes
  再在 profile patch 手动 insert 本插件行（此时不要用 bundle 安装，避免重复 id）。
- 测试：在包目录执行 node tests/plugin.test.mjs（10 个用例）。
- 发布：见 PUBLISHING.md；包内已带 cordis.patch.yml 与 dsh.bundle.patch。

## License

MIT © 2026 Picasso。lib/md2docx.py 改编自 dsh-video-coursemap（MIT），见 THIRD_PARTY_NOTICES.md。
