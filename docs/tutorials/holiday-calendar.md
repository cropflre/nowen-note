# 节假日日历图层（Issue #848）

在任务月历或每日记录的「瞬间日历」中展开「日历显示设置」，启用「中国大陆法定节假日」。两处日历共享当前浏览器 / 设备的开关，默认关闭，不随账号同步。日期格显示「休 / 班」及节日名称，悬停或辅助技术可读取完整说明。

节假日只作展示，不创建任务或提醒，不调整截止日期、重复规则，也不进入任务的 ICS 导出。

## 年度数据与更新

- 随包内置 2026 年数据，覆盖全部 33 天放假安排及 6 天调休上班，依据[国务院办公厅年度通知](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html)。未提供年度数据时明确提示，不推算未来调休安排。
- 启用后，浏览器直接从固定的 Nowen Note 项目地址读取年度文件：`https://raw.githubusercontent.com/cropflre/nowen-note/main/frontend/public/holidays/cn-{year}.json`。自动检查每年最多每天一次，重新打开页面也保留检查间隔；保持页面打开或恢复网络时同样检查间隔。「检查更新」允许手动重试。
- Docker / 自建服务端不需要访问外网。客户端无法访问 GitHub、404、超时或数据校验失败时，继续使用内置或已缓存数据。开关关闭时不发起更新请求，并取消进行中的请求。
- 更新不携带应用凭据，不跟随重定向；8 秒超时，流式读取最多 64 KiB。格式、地区、年份、版本、真实日期、已知节日及政府来源链接校验通过后才应用。每次完整替换一个年度，支持修订与删除，不接受降级版本。
- 缓存保存在浏览器 localStorage；不可持久化时明确提示，仍可在本次页面中使用。该公共参考数据不参与笔记、任务、Outbox 或备份协议。

## 维护年度文件

维护入口是 `frontend/public/holidays/cn-2026.json`；同一文件用于随包数据和项目更新源。年度文件包含 `schemaVersion: 1`、`region: "CN"`、`year`、递增整数 `revision`、官方 `sourceUrl` 和以 `YYYY-MM-DD` 为键的 `days`。日期条目只包含 `type`（`holiday` / `makeup-workday`）和节日标识 `name`。

收到正式年度通知后，核对所有放假区间与补班日期，再新增对应 `cn-{year}.json`。修订已有年度时增加 `revision`，保留完整年度快照；移除的日期不再保留。不要根据农历算法、往年安排或未确认预测填充补班。

新年度需要同时在 `frontend/src/lib/holidayCalendar.ts` 的 `BUNDLED_HOLIDAY_YEARS` 注册，才能随新安装包离线提供；先前版本可在年度文件合入 `main` 后在线获取（兼容当前 schema 和已知节日标识）。源文件合入与部署 / 发布是独立步骤，本功能不自动发布数据或软件。

验证：运行 `frontend/src/lib/__tests__/holidayCalendar.test.ts`、`frontend/src/components/calendar/__tests__/HolidayCalendars.test.tsx`，以及现有任务日期与瞬间日历回归。界面需检查桌面与窄屏、启用 / 关闭、断网及未知年度。
