export interface Article {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  category: string;
  tags: string[];
  coverImage: string;
  readTime: number;
  createdAt: string;
}

export const mockArticles: Article[] = [
  {
    id: '1',
    title: '深入浅出 React Server Components',
    slug: 'react-server-components-deep-dive',
    excerpt: '探索 React Server Components 的核心概念及其对现代 Web 开发的影响。',
    content: '# 深入浅出 React Server Components\n\nReact Server Components (RSC) 是 React 团队近年来最重大的创新之一...',
    category: 'React',
    tags: ['React', 'Server Components', 'Next.js'],
    coverImage: 'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=abstract%20modern%20web%20development%20concept%20with%20react%20logo%20dark%20theme&image_size=landscape_16_9',
    readTime: 8,
    createdAt: '2024-03-15T10:00:00Z',
  },
  {
    id: '2',
    title: 'TypeScript 5.0 新特性全解析',
    slug: 'typescript-5-new-features',
    excerpt: '详细介绍 TypeScript 5.0 带来的装饰器支持、性能提升及语法改进。',
    content: '# TypeScript 5.0 新特性全解析\n\nTypeScript 5.0 引入了许多令人兴奋的新特性，最受关注的是对装饰器的全新支持...',
    category: 'TypeScript',
    tags: ['TypeScript', 'Frontend'],
    coverImage: 'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=typescript%20logo%20with%20code%20and%20abstract%20geometric%20shapes%20dark%20blue%20theme&image_size=landscape_16_9',
    readTime: 12,
    createdAt: '2024-03-10T14:30:00Z',
  },
  {
    id: '3',
    title: '使用 GSAP 打造电影级的 Web 动画',
    slug: 'gsap-animation-tutorial',
    excerpt: '学习如何利用 GSAP 库创建流畅、高性能的网页交互动画。',
    content: '# 使用 GSAP 打造电影级的 Web 动画\n\nGSAP (GreenSock Animation Platform) 是 Web 动画领域的黄金标准...',
    category: 'Animation',
    tags: ['GSAP', 'Animation', 'UX'],
    coverImage: 'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=dynamic%20flowing%20abstract%20animation%20visuals%20colorful%20and%20futuristic&image_size=landscape_16_9',
    readTime: 10,
    createdAt: '2024-03-05T09:15:00Z',
  },
  {
    id: '4',
    title: '微前端架构实践指南',
    slug: 'micro-frontends-practice',
    excerpt: '在大型企业级应用中实施微前端架构的挑战与最佳实践。',
    content: '# 微前端架构实践指南\n\n微前端将微服务的理念延伸到了前端开发领域...',
    category: 'Architecture',
    tags: ['Architecture', 'Micro-Frontends'],
    coverImage: 'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=complex%20modular%20architecture%20diagram%20style%20abstract%20tech%20background&image_size=landscape_16_9',
    readTime: 15,
    createdAt: '2024-02-28T16:45:00Z',
  },
];
