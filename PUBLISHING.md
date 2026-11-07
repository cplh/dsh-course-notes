# 发布指南（dsh-course-notes）

面向作者：把本包发布到 npm，并提交到 awesome-dsh-plugin 列表，让 dshmarket / DSH Discover 能搜到。

## 0. 发布前确认

- GitHub 用户名、仓库地址：cplh/dsh-course-notes（作者名 Picasso）；改 URL 时同步 package.json 的 repository/homepage/bugs、本文件与 publishing/awesome-entry.yml。
- npm 包名：dsh-course-notes 目前未被占用（发布前可再执行 npm view dsh-course-notes 确认）。
- 版本：package.json 与 lib/index.js 的 VERSION 保持一致（当前 1.1.0）。
- 包内不能有：知识笔记/、课程知识地图/、delivered.json、绝对路径、密钥。

## 0.1 授权（本机现状）

- 本机没有安装 gh，也没有 GITHUB_TOKEN / npm 登录；npm 默认 registry 是淘宝镜像（只读，不能发布）。
- GitHub：使用 classic PAT（至少 repo 权限）或先 gh auth login；仓库尚不存在时，PAT 需要能创建仓库。
- npm：npm login --registry=https://registry.npmjs.org（或 npm Automation / Granular Token，带 dsh-course-notes 读写）。
- 可选：把两个 token 写在 工作区/.env.publish（不要提交、发布后删除），由发布脚本读取；不要把 token 写进仓库或 README。

## 1. 本地检查

    cd dsh-course-notes
    node --check lib/index.js
    node tests/plugin.test.mjs

    # 看 npm 包会带哪些文件（不会真正发布）
    npm pack --dry-run

应看到：package.json、cordis.patch.yml、lib/、README.md、LICENSE、THIRD_PARTY_NOTICES.md、CHANGELOG.md、tests/；不能出现输出目录。

## 2. 发布到 npm

    npm login --registry=https://registry.npmjs.org
    npm publish --access public --registry=https://registry.npmjs.org

> 本机 npm 默认 registry 被设为淘宝镜像（只读，不能发布）；发布必须显式带 --registry=https://registry.npmjs.org。

发布后确认：

    npm view dsh-course-notes version --registry=https://registry.npmjs.org

## 3. 建 GitHub 仓库（公开发布）

- 仓库至少保留 1 天历史后再提交 awesome 列表（列表规则要求）。
- 给仓库加 dsh-plugin topic。
- 建议打 tag：v1.1.0；可选发 GitHub Release。
- 确认 package.json 的 dsh.bundle.patch 指向 cordis.patch.yml。

## 4. 提交 awesome-dsh-plugin 列表

向 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 提 PR，新增一个文件
data/plugins/cplh__dsh-course-notes.yml（一插件一文件）：

    url: https://github.com/cplh/dsh-course-notes
    name: cplh/dsh-course-notes
    category: docs
    description:
      en: "Bilibili course notes for DSH: watches Bilibili videos, builds subject knowledge maps, and delivers same-name Markdown + Word notes with the video link in a new session. Requires dsh-video-coursemap and dsh-memory-evolve; Windows only."
      zh: "B站课程知识笔记：监听 B 站视频，生成学科知识地图，并在新会话交付带视频链接的同名 Markdown + Word 笔记。需先安装 dsh-video-coursemap 与 dsh-memory-evolve；仅 Windows。"

列表的硬性要求：

- 仓库声明 dsh.bundle（package.json 的 dsh.bundle.patch）；
- 仓库至少 1 天历史；
- 有 dsh-plugin topic；
- 描述与实际行为一致，且插件能被 dsh plugin add 安装。

PR 合并后，列表 README、索引和站点会自动重建，通常一天内生效。

## 5. 别人怎么搜到

- dshmarket（推荐市场插件）：打开即读取 awesome-dsh-plugin.com/plugins.json，自动出现，可搜索/一键安装。
- DSH 自带 Discover：默认没有索引源；用户在「插件 → 发现 → 索引源」添加
  https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json 后即可搜索到。
- 网页目录：awesome-dsh-plugin.com、dshget.com 等会跟随同一份数据。

## 6. 安装后的配置

bundle 安装会自动 insert 插件行；只再加 config 覆盖，不要再写一条 insert（重复 id 会报错）：

    - id: dsh-course-notes
      config:
        coursemapOutputDir: 'C:\Users\<you>\课程知识地图'
        outputDir: 'C:\Users\<you>\课程笔记'
        sessionCwd: 'C:\Users\<you>\项目'

## 7. 后续更新

1. 改代码、升 package.json 版本（同步 lib/index.js 的 VERSION）；
2. npm publish；
3. 可选打 GitHub tag/Release；
4. dshmarket 会按 npm 版本提示更新；Discover 索引随 catalog 重建更新。

## 8. 已知限制（写进 README/描述）

- Windows-only（依赖 dsh-video-coursemap 的前台窗口检测）；package.json 已声明 os: win32。
- 需要 dsh-memory-evolve 的会话编排与 memory 工具；需要 Python 3 + python-docx。
- B 站匿名接口限制、新会话 token 成本、旧笔记需 force 重发补齐。
