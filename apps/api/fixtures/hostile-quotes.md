---
slug: hostile-quotes
title: 满是引号的代码示例
excerpt: 正文含大量 ASCII 单引号——迁移 04 正是死在这类内容上。
category: TypeScript
tags: [TypeScript, 陷阱]
readTime: 6
status: published
publishedAt: 2026-09-21T08:30:00Z
---
# 满是引号的代码示例

这段代码里全是单引号，SQL 字符串字面量会被它提前终止：

```ts
const r = ok({ id: 1, name: 'demo' })
function greet(user: string) { return 'hello ' + user }
const msg = 'don\'t forget: it\'s a trap'
```

英文缩写也带单引号：it's fine, don't worry, we're good.

数组字面量：`['a', 'b', 'c']`
