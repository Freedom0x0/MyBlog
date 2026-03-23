update public.articles
set
  category = 'JavaScript',
  tags = array['JavaScript','TypeScript','工程化','最佳实践'],
  excerpt = '用更接近实战的方式梳理 TS 5 的关键变化：你该如何升级、怎么用、容易踩哪些坑。',
  content_md = '# TypeScript 5.x 新特性：按“能落地”的方式来学\n\n这篇文章不是把所有 release note 逐条翻译，而是用我写笔记的方式：**先讲你为什么要关心**，再给出**可以直接抄走的用法**，最后列一份**升级检查清单**。\n\n## 1. 你为什么要升级\n\n- 类型推导更聪明：减少你写类型的成本\n- 编译性能更好：大型项目能明显感受到\n- 语法能力更完整：写库/写框架更顺手\n\n## 2. 我最常用的 3 个点\n\n### 2.1 更友好的类型工具组合\n\n```ts\ntype ApiResult<T> = { data: T; error?: string }\n\nfunction ok<T>(data: T): ApiResult<T> {\n  return { data }\n}\n\nconst r = ok({ id: 1, name: 'demo' })\n```\n\n### 2.2 工程里怎么升级（我自己的流程）\n\n1. 先把 `typescript` 升级到目标版本\n2. 跑一遍 `tsc`，记录报错类型\n3. 按“影响范围”从小到大修：工具类型 → 业务类型 → 构建配置\n4. 最后再跑一遍 lint/测试\n\n## 3. 常见坑\n\n- `skipLibCheck` 不是万能的：它只是让你暂时不看依赖的错误\n- 项目里存在多份 `tsconfig` 时，build 模式要确认引用关系\n\n## 4. 小结\n\n如果你只想最小成本升级：**先升级 + 跑 tsc + 分批修类型**。升级完成后，再把新语法/新类型工具逐步引入到新代码里。\n',
  updated_at = timezone('utc'::text, now())
where slug = 'typescript-5-new-features';

update public.articles
set
  category = 'JavaScript',
  tags = array['JavaScript','GSAP','动画','交互'],
  excerpt = '我常用的一套 GSAP 动画组织方式：时间线、进入/离场、滚动触发与性能优化。',
  content_md = '# 用 GSAP 做动画：我常用的“可维护”写法\n\n很多教程写 GSAP 都很炫，但一落地就变成一堆散落的 `gsap.to()`。我更喜欢用一套固定结构：**timeline 组织** + **触发点清晰** + **可回收**。\n\n## 1. 最小可用模板\n\n```ts\nimport gsap from 'gsap'\n\nexport function enter(el: HTMLElement) {\n  const tl = gsap.timeline()\n  tl.fromTo(el, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6 })\n  return () => tl.kill()\n}\n```\n\n## 2. 时间线怎么分层（我习惯这样写）\n\n- 页面级：负责整体入场/离场\n- 区块级：负责某一个 section 的动画\n- 元素级：负责 hover/点击等微交互\n\n## 3. 滚动触发（思路）\n\n当你要做“滚动渐入/视差”，核心不是动画本身，而是：\n- 触发点统一\n- 元素销毁时能清理\n- 低端设备不掉帧\n\n## 4. 性能小抄\n\n- 尽量用 `transform/opacity`\n- 大图片配合懒加载\n- 动画结束就 `kill()`，不要让 timeline 常驻\n\n## 5. 小结\n\n动画写得“可维护”，比写得“更炫”更重要：timeline 管理、触发点统一、能回收，项目就不会越写越乱。\n',
  updated_at = timezone('utc'::text, now())
where slug = 'gsap-animation-tutorial';

update public.articles
set
  category = 'JavaScript',
  tags = array['JavaScript','微前端','架构','工程化'],
  excerpt = '不讲概念堆砌，直接按落地视角：你为什么需要微前端、怎么拆、怎么部署、怎么避免踩坑。',
  content_md = '# 微前端实践：按“能上线”的方式讲清楚\n\n我写架构类文章会尽量避免空话：先说明**为什么要做**，再明确**边界怎么划**，最后把**上线要注意的坑**列出来。\n\n## 1. 什么时候需要微前端\n\n- 一个仓库已经大到无法协作\n- 多团队并行开发，发布节奏完全不同\n- 历史包袱重，无法一次性重构\n\n如果你只是“想试试”，先别上微前端。\n\n## 2. 我推荐的拆分方式\n\n- 先按业务域拆：订单/商品/用户\n- 再按部署域拆：独立构建、独立发布\n- 最后才考虑技术栈：能不混就不混\n\n## 3. 运行时集成（思路）\n\n最关键的是这三件事：\n- 路由如何接管\n- 状态如何隔离\n- 资源如何加载/卸载\n\n## 4. 你一定会踩的坑\n\n- 公共依赖版本冲突（尤其是 UI 库）\n- CSS 污染（必须隔离）\n- 首屏变慢（要做预加载/缓存）\n\n## 5. 小结\n\n微前端不是银弹。它解决的是“组织与发布”问题，不是“技术炫技”。按业务域拆、保证独立发布、做好隔离与性能，才能真正落地。\n',
  updated_at = timezone('utc'::text, now())
where slug = 'micro-frontends-practice';

