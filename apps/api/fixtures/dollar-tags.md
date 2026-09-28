---
slug: dollar-tags
title: 正文里含有美元引号标签
excerpt: 若迁移用 $md$ 包裹内容，这段正文会提前终止它。
category: PostgreSQL
tags: [SQL, 引号]
readTime: 3
status: published
publishedAt: 2026-09-21T09:00:00Z
---
# 正文里含有美元引号标签

下面这行如果出现在 `$md$...$md$` 包裹的内容里，会把美元引号提前闭合：

    $md$

还有这个：$$ 、$1 、$SQL$ 、$tag$。
