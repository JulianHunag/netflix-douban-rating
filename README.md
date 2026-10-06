# Netflix 豆瓣评分

一个油猴脚本：在 Netflix 网页版上直接显示**豆瓣评分**和 **IMDb 评分**，不用点进详情。

A Tampermonkey userscript that shows Douban and IMDb ratings right on Netflix browse cards.

```
豆 8.3 S5 │ IMDb 8.6
```

## 显示在哪里

- 首页、分类页的每张卡片（右上角）
- 首页顶部的大图推荐（接在"节目 • 剧情片 • 2013 • 共 6 季"这一行后面）
- 鼠标悬停弹出的预览框
- 详情弹窗，以及里面"更多类似影片"的卡片

卡片滚进视野才会去查，查过的结果会缓存，下次打开秒出。

## 安装

1. 在 Chrome 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 新版 Chrome 需要在 `chrome://extensions` → Tampermonkey → 详情里打开「允许用户脚本」（旧版 Chrome 是打开开发者模式）。
3. 打开下面的链接，Tampermonkey 会弹出安装页，点「安装」：

   <https://raw.githubusercontent.com/JulianHunag/netflix-douban-rating/main/netflix-douban-rating.user.js>

之后 Tampermonkey 会从这个地址自动检查更新。

## 角标说明

| 显示 | 含义 |
|---|---|
| `豆 8.3` | 豆瓣评分，8 分及以上为金色 |
| `S5` / `第5季` | 剧集显示的是哪一季，默认是 Netflix 上最新的那一季；悬停可看各季评分 |
| `豆 7.9?`（虚线） | 按片名推断的匹配，不一定准 |
| `IMDb 8.6` | IMDb 评分 |
| `豆 …` | 正在查豆瓣 |
| `豆 –` | 豆瓣没找到对应条目，或豆瓣暂无评分 |
| `豆 限流` | 豆瓣暂时限制了这个 IP 的请求，到点自动重试 |
| `豆 暂停` | 本小时的豆瓣查询额度用完，到点自动继续 |
| `豆 !` | 其他查询错误，稍后自动重试 |

- 点角标的豆瓣部分打开豆瓣条目，点 IMDb 部分打开 IMDb 页面。
- **Alt + 点击**角标可以手动指定豆瓣条目（填豆瓣链接或编号）；清空则取消手动指定。
- Tampermonkey 菜单里有「清空豆瓣评分缓存（保留手动纠正）」和「切换调试日志」。

## 怎么找到对应的豆瓣条目

Netflix 页面自己加载数据时，就带着每部片的编号、片名、类型、年份和季数，脚本直接读取，不额外请求 Netflix。然后：

1. 用 Netflix 编号去 [Wikidata](https://www.wikidata.org/) 查豆瓣编号或 IMDb 编号（精确对应）。
2. 只有 IMDb 编号的，用它去豆瓣搜出豆瓣条目（精确对应）。
3. 都没有的，按「片名 + 年份 + 类型」在豆瓣搜索推断，不确定时会标出来。

IMDb 分同样优先按 Netflix 编号精确对应；Wikidata 里没有这个 Netflix 编号时（同一部片在不同地区的 Netflix 编号可能不同），再用匹配到的豆瓣编号去 Wikidata 反查 IMDb 编号。

## 关于豆瓣的访问

豆瓣已经不向个人开发者提供公开 API。脚本访问的是豆瓣的公开网页，请只做个人使用。为了不给豆瓣添负担，也避免被限流，脚本：

- 发给豆瓣的请求**不带你的豆瓣登录信息**；
- 一次只发一个请求，间隔约 2.5 秒；
- 所有标签页合计每小时最多请求豆瓣 120 次；
- 被豆瓣限流后自动暂停，暂停时间逐次加倍（15 分钟起，最长 4 小时）；
- 结果缓存 7 天（没找到的缓存 2 天）。

请不要调高这些限制。豆瓣对一个 IP 限流后，不登录访问豆瓣网站也会被要求登录。

## IMDb 数据

IMDb 评分来自 IMDb 官方的非商业数据集 `title.ratings.tsv.gz`，限个人、非商业使用。脚本每周最多下载一次（约 8.7 MB），只保留评分人数不少于 20 的条目，存在浏览器里 netflix.com 名下的 IndexedDB 中（约 9 MB）。

Information courtesy of IMDb (https://www.imdb.com). Used with permission.

## 已知限制

- 部分片子会被豆瓣搜索隐藏，这类只能显示 `–`。
- Netflix 的中文译名和豆瓣不同、Wikidata 里又没有对应编号的片子，可能查不到；可以 Alt + 点击手动指定。
- 豆瓣搜索每次只返回前 20 条，播了很多季的老剧可能缺几季。
- Netflix 改版后页面结构可能变化，到时需要更新脚本。

## 开发

全部代码在 `netflix-douban-rating.user.js` 一个文件里。匹配和请求相关的核心逻辑不依赖页面，可以在 Node 里直接 `require` 这个文件做测试。

## 许可

脚本以 MIT 许可发布（见脚本头部声明）。豆瓣、IMDb、Wikidata、Netflix 的数据和商标归各自所有者。
