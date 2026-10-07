'use client'

import React from 'react'
import Link from 'next/link'
import { Swiper, SwiperSlide } from 'swiper/react'
import { Autoplay, Navigation, Pagination, EffectFade } from 'swiper/modules'
import { motion } from 'framer-motion'
import type { ArticleSummary } from 'shared'

// Import Swiper styles
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import 'swiper/css/effect-fade'

interface HeroCarouselProps {
  articles: ArticleSummary[]
  /**
   * "The API could not be read", which is *not* the same as "there are no articles".
   *
   * In the SPA this third state was `loading`, because the list arrived from a
   * browser-side request that was genuinely in flight. Here the list arrives from the
   * server, so no request is pending in the visitor's browser — the state that can
   * happen instead is a degraded read, and `unavailable` names that. Either way the
   * rule is the one S3 established: an empty hero must never advertise a claim about
   * the blog's contents that it cannot support.
   */
  unavailable?: boolean
}

const HeroCarousel: React.FC<HeroCarouselProps> = ({ articles, unavailable = false }) => {
  if (!articles.length) {
    return (
      <div className="w-full h-[60vh] md:h-[80vh] relative overflow-hidden flex items-end">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-background" />
        <div className="relative w-full max-w-5xl mx-auto px-4 pb-16">
          {unavailable && (
            <div className="inline-flex items-center rounded-full bg-primary/15 text-primary px-4 py-2 text-xs font-semibold">
              接口不可达
            </div>
          )}
          <div className="mt-6 text-4xl md:text-6xl font-black tracking-tight">Guoshaoran Blog</div>
          <div className="mt-4 text-muted-foreground text-base md:text-lg max-w-2xl">
            {/* The two empty states stay two sentences, not one. */}
            {unavailable
              ? '暂时拉不到文章轮播内容（接口不可达）。稍后刷新即可，这里不放占位内容。'
              : '这里还没有文章。'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-[60vh] md:h-[80vh] relative overflow-hidden">
      <Swiper
        modules={[Autoplay, Navigation, Pagination, EffectFade]}
        effect="fade"
        speed={1000}
        autoplay={{
          delay: 5000,
          disableOnInteraction: false,
        }}
        loop={true}
        pagination={{ clickable: true }}
        navigation={true}
        className="w-full h-full"
      >
        {articles.map((article) => (
          <SwiperSlide key={article.slug}>
            {/* `onClick={() => navigate(...)}` in the SPA; a real anchor here, which is
                the same interaction plus a URL the browser and a crawler can see. */}
            <Link
              href={`/blog/${article.slug}`}
              className="relative block w-full h-full cursor-pointer"
            >
              {article.coverImage ? (
                <img
                  src={article.coverImage}
                  alt={article.title}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                /**
                 * Null in the contract, so no `<img src="">`: an empty src is the
                 * broken-image slot, and this hero is full-bleed, so it would be the
                 * first thing a visitor sees wrong.
                 */
                <div className="absolute inset-0 bg-gradient-to-br from-muted to-secondary" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
              <div className="absolute inset-0 flex flex-col items-center justify-end pb-20 px-4 text-center">
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8 }}
                >
                  <span className="inline-block px-3 py-1 mb-4 text-xs font-semibold tracking-wider text-primary-foreground uppercase bg-primary rounded-full">
                    {article.category}
                  </span>
                  <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold text-foreground mb-4 max-w-4xl leading-tight">
                    {article.title}
                  </h2>
                  <p className="text-muted-foreground text-sm md:text-lg max-w-2xl mx-auto line-clamp-2">
                    {article.excerpt}
                  </p>
                </motion.div>
              </div>
            </Link>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  )
}

export default HeroCarousel
