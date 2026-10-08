'use client'

import { motion } from 'framer-motion'

/**
 * The "探索技术的世界" band of `apps/web/src/pages/Home.tsx`, ported.
 *
 * Client component only because both halves are `motion.div` with `whileInView` —
 * animation, not data. The text and the avatar URL are the SPA's, unchanged.
 */
export default function HomeIntro() {
  return (
    <div className="flex flex-col md:flex-row items-center justify-between gap-12 mb-20">
      <motion.div
        initial={{ opacity: 0, x: -50 }}
        whileInView={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.8 }}
        className="flex-1"
      >
        <h1 className="text-4xl md:text-6xl font-bold mb-6">探索技术的世界</h1>
        <p className="text-muted-foreground text-lg md:text-xl leading-relaxed">
          这里记录了我在 React、TypeScript 和 Web 动画领域的研究与实践。
          欢迎来到我的个人博客，一起探索现代 Web 开发的魅力。
        </p>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        whileInView={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="relative"
      >
        <div className="w-64 h-64 md:w-80 md:h-80 rounded-full overflow-hidden border-4 border-primary/20">
          <img
            src="https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=cool%20modern%20developer%20avatar%20minimalist%20style%20dark%20theme&image_size=square"
            alt="Avatar"
            className="w-full h-full object-cover"
          />
        </div>
      </motion.div>
    </div>
  )
}
