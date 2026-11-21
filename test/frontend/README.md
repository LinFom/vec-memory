# 记忆管理前端验证

独立入口：当前记忆服务的 `/manage.html#/people`。无需构建、无需新依赖。
演示入口：`/manage.html?demo=1&theme=dark#/people/demo-person`。数据和写入均在内存；页面刷新会重置。演示图谱不加载真实数据。在编辑内容中输入 `[409]` 或 `[503]` 可分别触发冲突和暂不可用。

从库根执行：

```powershell
node --test test/frontend/client.test.mjs
$env:MV_FRONTEND_ARTIFACTS = 'E:/指定的截图目录'
node test/frontend/browser.mjs
```

浏览器脚本使用本机 Chrome 和 Node 自带 WebSocket/CDP，无 npm 浏览器依赖。默认 Chrome 路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可用 `CHROME_PATH` 覆盖。脚本创建并清理临时库与浏览器配置，不读生产库；`MV_FRONTEND_ARTIFACTS` 未设置时截图亦随临时目录清理。指定目录后保留 PNG 和 `results.json`。

客户端测试覆盖迟到响应（包括传输忽略 abort）、取消、写入地址及重试正文稳定、演示隐藏恢复。浏览器检查覆盖合成复杂状态、真实隔离库的修订/隐藏/恢复、主体登记/别名/合并/撤销、错误页、旧入口、实例整页切换、iframe 和主题、弹层回焦、960px 布局。精确检查列表以 `results.json` 为准。

保留旧 `/` 星图与各旧 HTML、脚本和查询参数语义，仅增加管理入口。生产宿主未启动或修改；父窗口主题通过与宿主相同的 `mv-theme` 协议测试，不能据此宣称生产宿主已经验收。
