# IGP Development Platform

本项目是飞书本地网页应用测试入口。启动后，在飞书客户端中打开本地地址，页面右上角会显示当前飞书用户的头像和名称，并在左侧显示项目基础信息列表。

## 本地配置

1. 将 `config/config.example.json` 复制为 `config/config.json`，并填写实际配置；该运行配置含密钥且不会提交到仓库。
2. `config/config.json` 是默认运行配置，构建时会覆盖到 `Publish/config.json`。
3. 当前配置监听 `0.0.0.0:3000`，对外访问地址是 `http://172.16.20.205:3000/`，飞书网页应用主页和可信地址也应填写这个地址。
4. 在 `bitable.projectBase` 中填入“项目基础信息”多维表格的 `appToken`、`tableId`，需要固定视图时再填 `viewId`。
5. 在 `bitable.projectPermission` 中填入“项目权限”多维表格配置；只有当前飞书用户出现在任意权限用户列里的项目才会显示。
6. `bitable.projectBase.fieldNames` 默认读取 `项目ID`、`项目名称`、`项目图标` 三列，表格列名不同才需要修改。
7. `bitable.projectPermission.fieldNames.permissionUsers` 默认读取 `超级管理员`、`研发`、`测试`、`发行`、`商务` 五列，权限列名不同才需要修改。
8. 在 `bitable.toolPermission` 中填入“工具权限”多维表格配置；`tableId` 可留空，系统会默认读取第一张数据表。
9. `bitable.toolPermission.fieldNames.department` 默认读取 `部门`；工具列默认读取 `需求列表`、`Bug列表`、`打包列表`、`内容审查`，值为 `允许` 才显示该工具。
10. 在 `knowledgeBase.spaceId` 中填入知识库空间 ID；`requirementsParentName` 默认是 `需求列表`，`bugsParentName` 默认是 `Bug列表`，模板名默认都是 `模板`。
11. `knowledgeBase.requirementsFieldNames` 用于配置需求表字段名；默认读取 `需求ID`、`需求标题`、`需求描述`、`优先级`、`处理人员`、`处理状态`、`提出时间`、`期望时限`、`留言`。
12. `knowledgeBase.bugsFieldNames` 用于配置 Bug 表字段名；默认读取 `BugID`、`标题`、`详细描述`、`优先级`、`处理人员`、`处理状态`、`发现时间`、`期望时限`、`留言`。
13. `requirementsIdPrefix` 和 `bugsIdPrefix` 用于配置提交时自动生成的编号前缀，默认分别是 `R-` 和 `B-`；编号位数默认是 4。
14. 点击项目内的“需求列表”或“Bug列表”时，系统会在知识库中找到或创建对应节点，并按项目ID准备同名多维表格；不存在时会复制节点下的“模板”多维表格。
15. `knowledgeBase.bugsTemplateAppToken` 默认填入当前 Bug 模板多维表格 token：`ZuHmbPMjzaDFCUsge7PcjkAsn4e`。
16. 留言提及人员和提交时处理人员不再搜索通讯录，候选人来自当前项目中有权使用当前工具的人员。
17. 在飞书开发者后台把网页应用主页地址配置为本机可访问地址，例如 `http://192.168.1.23:3000/`。

打包时，所有产物都会生成到根目录 `Publish` 文件夹。每次构建都会把 `config/config.json` 覆盖到 `Publish/config.json`。服务端会读取这个文件，但不会把 App Secret 返回给浏览器。
`Publish` 根目录会生成 `StartWebBackend.bat` 和 `StopWebBackend.bat`，用于一键启动和停止网页后端服务。

## 常用命令

```bash
npm install
npm run dev
npm run verify
npm run log-change -- "变动说明"
```

固定构建流程：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

每次变动后，使用 `npm run log-change -- "变动说明"` 自动升级版本号并更新 `UploadLog.md`。
