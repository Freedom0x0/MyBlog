import React from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { Autoplay, Navigation, Pagination, EffectFade } from 'swiper/modules';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { ArticleRecord } from '../utils/articlesApi';

// Import Swiper styles
import 'swiper/css';
import 'swiper/css/navigation';
import 'swiper/css/pagination';
import 'swiper/css/effect-fade';

const HeroCarousel: React.FC<{ articles: ArticleRecord[] }> = ({ articles }) => {
  const navigate = useNavigate();

  if (!articles.length) {
    return (
      <div className="w-full h-[60vh] md:h-[80vh] relative overflow-hidden flex items-end">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-background" />
        <div className="relative w-full max-w-5xl mx-auto px-4 pb-16">
          <div className="inline-flex items-center rounded-full bg-primary/15 text-primary px-4 py-2 text-xs font-semibold">
            Loading
          </div>
          <div className="mt-6 text-4xl md:text-6xl font-black tracking-tight">Guoshaoran Blog</div>
          <div className="mt-4 text-muted-foreground text-base md:text-lg max-w-2xl">
            正在加载文章轮播内容...
          </div>
        </div>
      </div>
    );
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
          <SwiperSlide key={article.id}>
            <div
              className="relative w-full h-full cursor-pointer"
              onClick={() => navigate(`/blog/${article.slug}`)}
            >
              <img
                src={article.cover_image ?? ''}
                alt={article.title}
                className="absolute inset-0 w-full h-full object-cover"
              />
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
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
};

export default HeroCarousel;
