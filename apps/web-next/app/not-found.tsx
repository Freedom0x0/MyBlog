import Link from 'next/link'

/**
 * What `notFound()` renders: the SPA's own "文章未找到" screen, so a bad slug looks the
 * way readers of the old page expect while the server now also answers **404** for it —
 * which is the part an SPA cannot do and a crawler acts on.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground">
      <h1 className="text-4xl font-bold mb-4">文章未找到</h1>
      <p className="mb-4 text-muted-foreground">这个地址下没有已发布的文章。</p>
      <Link href="/" className="text-primary hover:underline">
        返回首页
      </Link>
    </div>
  )
}
