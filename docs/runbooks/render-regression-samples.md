# 文档渲染回归样例

> 这份文档本身就是回归夹具：在读视图里从上往下走一遍，就能覆盖当前全部渲染与导出能力。

## 0. 怎么用

1. 打开本文（默认就是读视图）。
2. 逐条对照每个小节的「预期」。
3. `Ctrl+P` 看打印版式；点「导出 .md」看下载文件与正文是否一致。
4. 在左侧文档列表搜索框输入 `回归锚点`，应命中文档正文并显示摘要。

## 1. 标题与 TOC

本文有 ≥2 个标题，因此正文顶部应出现目录，点击目录项会平滑滚到对应标题。

### 1.1 三级标题

#### 1.2 四级标题

## 2. 行内语法

**加粗**、*斜体*、`行内代码`、[普通链接](https://example.com)、[很长的链接文字用来测换行](https://example.com/a/very/long/path/that/should/not/break/the/layout/at/all)。

## 3. 列表

- 无序项一
- 无序项二
- 无序项三

1. 有序项一
2. 有序项二
3. 有序项三

## 4. 引用与分隔线

> 引用块：这一段故意写得长一点，用来确认引用在窄屏下也能正常折行，不会撑破右侧边界。

---

## 5. 表格

| 能力 | 状态 | 备注 |
| --- | :---: | --- |
| 表格 | ✅ | 窄屏可横向滚动，打印时应固定布局换行 |
| 行内语法 | ✅ | 加粗 / 斜体 / 行内代码 / 链接 |
| 代码块 | ✅ | 块头显示语言，右侧可复制 |
| 图表 | ✅ | ```chart 柱 / 折 / 饼 |
| 流程图 | ✅ | ```flow 子集 |
| 导出与打印 | ✅ | 下载 .md，打印不横向溢出 |

## 6. 代码块

```js
function hello(name) {
  return 'hello ' + name;
}
```

```bash
npm run test:client
```

```
无语言围栏：块头应显示 text，复制按钮可用
```

## 7. 图表

```chart type=bar title="回归：柱状图" unit="%"
读视图 90
流程图 70
导出 60
```

```chart type=pie title="回归：饼图"
表格 40
代码块 35
图表 25
```

## 8. 流程图

```flow
start[开始]
parse[解析 DSL]
layout[分层布局]
view[SVG 渲染]
err[降级提示]
start -> parse
parse -> layout
layout -> view
parse -> err
```

预期：4 层左→右，箭头在右端，节点文字不重叠；暗色主题下边框与文字仍可读。

## 9. 错误降级（预期看到报错框）

下面是**故意写坏**的两个块：页面其余部分必须正常，只有这两个块变成「无法解析」提示 + 原代码。

```flow
a[起点]
b[终点]
a -> b
b -> a
```

预期：`流程图无法解析：存在环：…` + 原代码块。

```chart type=bar
只有标签没有数值
```

预期：`图表无法解析：第 1 行应为「标签 数值」` + 原代码块。

## 10. 长文本与换行

这一行故意很长：Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat。

超长不换行 token：https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## 11. 搜索锚点

本文包含两个唯一锚点：**回归锚点-海象**、**回归锚点-雪豹**。
在列表搜索框输入「回归锚点」应列出本文，并在标题下方显示命中摘要；输入「雪豹」也应命中。

## 12. 导出与打印

- 导出文件名应为 `文档渲染回归样例.md`，内容与本文正文逐字一致。
- 打印预览：表格不横向溢出、代码块自动换行、图表与流程图不跨页断裂，工具栏与文档列表不出现。

## 13. 回归清单（勾完即通过）

| # | 检查项 | 预期 |
| --- | --- | --- |
| 1 | TOC 出现且可跳转 | 点击滚动到对应标题 |
| 2 | 行内语法 | 加粗/斜体/代码/链接都有样式 |
| 3 | 表格 | 有边框、可横向滚动 |
| 4 | 代码块语言标签 | js / bash / text |
| 5 | 复制按钮 | 点击后变「已复制」，剪贴板内容正确 |
| 6 | 柱状图 | 有坐标轴、数值标签 |
| 7 | 饼图 | 图例与百分比 |
| 8 | 流程图 | 4 层、箭头、无重叠 |
| 9 | 坏 flow | 报错框 + 原代码，其余正常 |
| 10 | 坏 chart | 报错框 + 原代码，其余正常 |
| 11 | 正文搜索 | 搜「雪豹」命中本文 |
| 12 | 导出 | 下载 .md，内容一致 |
| 13 | 打印 | 不横向溢出 |