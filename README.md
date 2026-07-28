# IGP Development Platform

本项目是飞书本地网页应用测试入口。启动后，在飞书客户端中打开本地地址，页面右上角会显示当前飞书用户的头像和名称，并在左侧显示项目基础信息列表。

## 本地配置

1. 将 `config/config.example.json` 复制为 `config/config.json`，并填写实际配置；该运行配置含密钥且不会提交到仓库。
2. `config/config.json` 是默认运行配置，构建时会覆盖到 `Publish/config.json`。
3. 当前配置监听 `0.0.0.0:3000`，对外访问地址是 `http://172.16.20.205:3000/`，飞书网页应用主页和可信地址也应填写这个地址。
4. 在 `bitable.projectBase` 中填入“项目基础信息”多维表格的 `appToken`、`tableId`，需要固定视图时再填 `viewId`。
5. 在 `bitable.projectPermission` 中填入“项目权限”多维表格配置；只有当前飞书用户出现在任意权限用户列里的项目才会显示。
6. `bitable.projectBase.fieldNames` 默认读取 `项目ID`、`项目名称`、`项目图标` 三列，表格列名不同才需要修改。
7. `bitable.projectPermission.fieldNames.permissionUsers` 默认读取 `超级管理员`、`研发超级管理员`、`研发`、`测试`、`发行`、`商务` 六列，权限列名不同才需要修改。
8. “项目权限”表必须新增人员列 `研发超级管理员`，并在每个项目行配置负责分配需求/Bug的人员；对应配置项是 `bitable.projectPermission.fieldNames.developmentSuperAdmins`。该角色可访问需求和 Bug、变更处理人，并会收到未指定处理人的分配卡片，但不继承删除或编辑内容等超级管理员权限。
9. 在 `bitable.toolPermission` 中填入“工具权限”多维表格配置；`tableId` 可留空，系统会默认读取第一张数据表。
10. `bitable.toolPermission.fieldNames.department` 默认读取 `部门`；工具列默认读取 `需求列表`、`Bug列表`、`反馈列表`、`打包列表`、`内容审查`，值为 `允许` 才显示该工具。
11. 在 `knowledgeBase.spaceId` 中填入知识库空间 ID；`requirementsParentName`、`bugsParentName`、`feedbackParentName` 默认分别是 `需求列表`、`Bug列表`、`反馈列表`，模板名默认都是 `模板`。
12. `knowledgeBase.requirementsFieldNames` 用于配置需求表字段名；除原有需求字段外，模板还必须包含单选字段 `需要提交附件`（选项为 `是`、`否`）和附件字段 `提交附件`，对应配置项为 `requiresSubmissionAttachment`、`submittedAttachments`。需求的 `处理状态` 单选字段包含 `待验收`，该状态按处理中统计。
13. `knowledgeBase.bugsFieldNames` 用于配置 Bug 表字段名；默认读取 `BugID`、`标题`、`详细描述`、`优先级`、`处理人员`、`处理状态`、`发现时间`、`期望时限`、`留言`。Bug 的 `处理状态` 单选字段同样包含 `待验收`。
14. `requirementsIdPrefix` 和 `bugsIdPrefix` 用于配置提交时自动生成的编号前缀，默认分别是 `R-` 和 `B-`；编号位数默认是 4。
15. 点击项目内的“需求列表”或“Bug列表”时，系统会在知识库中找到或创建对应节点，并按项目ID准备同名多维表格；不存在时会复制节点下的“模板”多维表格。服务启动后会异步为需求、Bug 模板及历史项目表补齐缺失的 `待验收` 选项，列表读取和模板复制时也会进行幂等检查。
16. `knowledgeBase.bugsTemplateAppToken` 默认填入当前 Bug 模板多维表格 token：`ZuHmbPMjzaDFCUsge7PcjkAsn4e`。
17. 留言提及人员和提交时处理人员不再搜索通讯录，候选人来自当前项目中有权使用当前工具的人员。
18. 创建需求时可选择是否需要处理人提交附件，默认选择 `否`。选择 `是` 后，处理人可在详情页的“提交附件”操作中增删附件、记录留言并按需通知提出人；附件为空时更新处理状态会要求二次确认。
19. `knowledgeBase.feedbackFieldNames` 用于配置反馈表字段名；提交反馈时服务端生成项目内 `F-0001` 编号，固定写入渠道“内部开发平台”和当前反馈时间，并将当前飞书身份、可选手机/邮箱及回访授权保存到 `联系信息数据` JSON。
20. 在飞书开发者后台把网页应用主页地址配置为本机可访问地址，例如 `http://192.168.1.23:3000/`。
21. 可选地在 `updates.manifestUrl` 填写 HTTPS 更新日志 JSON 地址。格式为 `schemaVersion`、`latestVersion` 和 `releases`，每条发布记录包含版本、发布时间和变更列表。
22. `dashboard` 用于配置项目总览：`cacheTtlMs` 是服务端聚合缓存时间，`staleDays` 是“长期无进展”阈值，`dueSoonDays` 是“即将到期”阈值；`statusGroups` 可按需求、Bug、反馈配置待处理、处理中、已完成和阻塞状态名称。
23. 项目总览只读取已存在的需求、Bug、反馈多维表格，不会因打开总览而创建或复制模板。页面默认显示项目全局数据，也可切换到“我的任务”，并通过实时事件或手动刷新更新。
24. “本周完成”、完成趋势和最近动态基于平台记录的状态变动与留言统计；早于平台记录的数据可能不完整，页面会显示数据口径提示。
25. `aiPlanning` 默认启用，Codex 默认模型为 `gpt-5.6-sol`。需要配置模型 URL、API Key，并在 `aiPlanning.projects` 中把飞书项目 ID 映射到后端设备上一个或多个项目根目录；缺少映射时需求/Bug详情仍会显示禁用入口和具体配置原因。
26. 需求和 Bug 的 AI 计划对话按当前飞书 Open ID 私有隔离并持久化到 `D:\DevelopmentPlatformDB`。其他项目成员和管理员不能读取该对话；只有用户主动提交的 Markdown 方案版本会进入项目共享方案列表。
27. Codex 全程使用只读沙箱、禁止网络和审批请求，只能读取配置的项目目录。它会先分析工作项、附件和代码；遇到无法从源码判断的关键决策时，最多集中询问三个问题，用户回答后在同一 Codex 线程继续分析，确认无剩余关键歧义后自动生成方案。
28. AI 计划默认分析普通附件以及需求的提交附件。图片直接作为本地图片输入，文本转为 UTF-8，DOCX/PPTX/XLSX/PDF/RTF/ODT/ODP/ODS 提取为 Markdown；不支持、损坏、超限或无法下载的附件会跳过并在对话中显示原因。临时内容位于 `D:\DevelopmentPlatformDB\tmp\ai-runs`，运行结束、失败或进入等待回答状态后立即清理，启动时也会清理超期目录。
29. `aiPlanning.attachments` 可配置文件数量、单文件和总大小、提取字符数及临时目录保留时间。`aiPlanning.notifications.enabled` 默认开启，在 Codex 需要用户回答、方案生成完成或运行失败时，向该私有对话的所有者发送飞书卡片，按钮可直达对应问题、方案或失败详情。

更新日志示例：

```json
{
  "schemaVersion": 1,
  "latestVersion": "0.1.63",
  "releases": [
    {
      "version": "0.1.63",
      "publishedAt": "2026-07-16T08:00:00Z",
      "changes": ["增加本地缓存和更新日志"]
    }
  ]
}
```

打包时，所有产物都会生成到根目录 `Publish` 文件夹。每次构建都会把 `config/config.json` 覆盖到 `Publish/config.json`。服务端会读取这个文件，但不会把 App Secret 返回给浏览器。
`Publish` 根目录会生成 `StartWebBackend.bat` 和 `StopWebBackend.bat`，用于一键启动和停止网页后端服务。发布包不预装应用 `node_modules`；首次双击启动时会使用内置 Node/npm 执行锁定版本的生产依赖下载，并在命令行显示 npm 进度和 HTTP 获取状态。
`ConfigureWebBackend.bat` 可在浏览器打开仅监听本机回环地址的可视化配置工具，`StopConfigureWebBackend.bat` 用于停止它；配置工具可在应用依赖尚未下载时运行，并且不会把已有密钥返回给浏览器。

## 局域网部署调试工具

`deployment-tool/` 是独立的 Windows Electron 工具，同一个安装包可选择：

- 开发端：扫描或手动连接目标电脑，配对后构建并发送离线发布包，控制服务、查看日志、回滚版本并打开 Node Inspector。
- 目标端：登录自启并驻留托盘，显示配对码，管理已配对开发端、持久化配置、发布版本和服务进程。

首次开发：

```powershell
npm run deploy-tool:install
npm --prefix deployment-tool run dev
```

生成可直接解压运行的 Windows x64 便携包：

```powershell
npm run deploy-tool:package
```

产物固定输出到 `deployment-tool/Publish/`，其中包含
`win-unpacked/` 和 Windows x64 便携 ZIP；不要放入主应用的根目录
`Publish/`。

需要 NSIS 安装器时可额外运行
`npm --prefix deployment-tool run package:installer`；该命令依赖本机可用的
NSIS/7-Zip 工具链。

目标端首次使用时选择目标端模式，并从现有 `Publish` 目录导入
`config.json`。配置与运行日志保存在工具管理的持久化状态目录中，不随发布版本切换。开发端选择项目仓库，扫描目标电脑并输入目标端显示的六位配对码。
从部署工具 `0.1.6` 起，目标服务统一通过固定的
`managed-runtime/runtime/node.exe` 启动，发布和回滚只更新该文件内容而不改变
程序路径。旧版本目标端升级后第一次启动可能仍需允许一次专用网络访问，后续应用
发布不会再因版本目录变化重复触发 Windows 防火墙应用授权。
从 `0.1.7` 起，目标端 Windows 进程检查带有明确超时；WMI 异常时状态接口会
保留已记录 PID并返回错误，不会无限等待、误清状态或重复启动服务。
从 `0.1.8` 起，目标端在上传前预留一个发布槽位，始终保护当前与上一版本；
失败上传会主动删除半包，目标代理启动时也会清理中断上传和暂存解压目录，避免
多次离线部署耗尽目标磁盘。
局域网扫描会先使用 UDP 广播；广播被防火墙或虚拟网卡拦截时，会继续探测
本机所在子网的默认控制端口 `47322`。也可以通过侧栏的手动连接按钮直接输入
目标 IP 和端口。目标端登录自启会携带并恢复 `--mode=target`，不会重新进入
工具模式选择页。

开发端工具运行且已有默认目标后，Codex 或终端可执行：

```powershell
npm run deploy:debug
npm run deploy:debug -- --status
npm run deploy:debug -- --logs stderr
npm run deploy:debug -- --logs client
npm run deploy:debug -- --action restart
```

默认命令会构建当前仓库、在开发电脑准备完整离线生产依赖、上传并激活新版本，然后检查运行版本、进程、健康接口、首页和启动错误日志。部署包不会包含目标端 `config.json`、日志或配对凭据。Node Inspector 只监听目标端回环地址，并通过已配对工具的认证隧道访问。

## 异常日志

浏览器上报的页面运行异常会以 UTF-8 JSONL 格式保存到本地：

- 开发环境：`logs/client-errors.log`
- 发布环境：`Publish/logs/client-errors.log`

每行以 `[client-error]` 开头，可直接搜索页面显示的错误编号。日志只包含经过脱敏和截断的诊断字段，不保存表单、需求/Bug内容、令牌或运行配置。文件达到 10 MB 后会轮转为 `client-errors.log.1`。

## 常用命令

```bash
npm install
npm run dev
npm run deploy-tool:test
npm run deploy-tool:build
npm run verify
npm run deploy:debug
npm run log-change -- "变动说明"
```

固定构建流程：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

每次变动后，使用 `npm run log-change -- "变动说明"` 自动升级版本号并更新 `UploadLog.md`。
