import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ArrowLeft, Clock, Calendar, Tag, Edit, Save, X, MessageSquare, Trash2 } from 'lucide-react';
import { mockArticles, Article } from '../utils/mockData';
import { useAuthStore } from '../store/authStore';
import { supabase } from '../lib/supabase';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { getArticleBySlug, upsertArticle, type ArticleRecord } from '../utils/articlesApi';

interface Comment {
  id: string;
  article_slug: string;
  user_id: string;
  user_name: string;
  avatar_url: string;
  content: string;
  created_at: string;
}

const ArticleDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [article, setArticle] = useState<Article | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [articleRecord, setArticleRecord] = useState<ArticleRecord | null>(null);
  
  const { user, isAdmin } = useAuthStore();
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loadingComments, setLoadingComments] = useState(true);

  useEffect(() => {
    if (!slug) return;

    const load = async () => {
      const record = await getArticleBySlug(slug);
      if (record) {
        setArticleRecord(record);
        setArticle({
          id: record.id,
          title: record.title,
          slug: record.slug,
          excerpt: record.excerpt,
          content: record.content_md,
          category: record.category,
          tags: record.tags || [],
          coverImage: record.cover_image || '',
          readTime: record.read_time || 5,
          createdAt: record.created_at,
        });
        setEditedContent(record.content_md);
        return;
      }

      const found = mockArticles.find((a) => a.slug === slug);
      if (found) {
        setArticle(found);
        setEditedContent(found.content);
      }
    };

    load();
  }, [slug]);

  useEffect(() => {
    if (slug) {
      fetchComments();
    }
  }, [slug]);

  const fetchComments = async () => {
    setLoadingComments(true);
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('article_slug', slug)
      .order('created_at', { ascending: false });
      
    if (!error && data) {
      setComments(data);
    }
    setLoadingComments(false);
  };

  const handleSave = async () => {
    if (!article || !slug) return;

    if (isAdmin) {
      const saved = await upsertArticle({
        slug,
        title: article.title,
        excerpt: article.excerpt,
        content_md: editedContent,
        category: article.category,
        tags: article.tags,
        cover_image: article.coverImage,
        read_time: article.readTime,
      });
      if (saved) {
        setArticleRecord(saved);
        setArticle({
          ...article,
          content: saved.content_md,
        });
        setEditedContent(saved.content_md);
        setIsEditing(false);
        return;
      }
    }

    setArticle({ ...article, content: editedContent });
    localStorage.setItem(`article_${slug}`, editedContent);
    setIsEditing(false);
  };

  const submitComment = async () => {
    if (!user || !newComment.trim() || !slug) return;
    
    const commentData = {
      article_slug: slug,
      user_id: user.id,
      user_name: user.user_metadata?.user_name || user.email?.split('@')[0] || 'Anonymous',
      avatar_url: user.user_metadata?.avatar_url || '',
      content: newComment.trim(),
    };

    const { data, error } = await supabase
      .from('comments')
      .insert([commentData])
      .select();

    if (!error && data) {
      setComments([data[0], ...comments]);
      setNewComment('');
    }
  };

  const deleteComment = async (id: string) => {
    const { error } = await supabase
      .from('comments')
      .delete()
      .eq('id', id);
      
    if (!error) {
      setComments(comments.filter(c => c.id !== id));
    }
  };

  if (!article) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground">
        <h1 className="text-4xl font-bold mb-4">文章未找到</h1>
        <Link to="/" className="text-primary hover:underline">返回首页</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Header Image */}
      <div className="relative h-[40vh] md:h-[60vh] w-full overflow-hidden">
        <img
          src={article.coverImage}
          alt={article.title}
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 max-w-4xl mx-auto px-4 pb-8">
          <Link
            to="/"
            className="inline-flex items-center text-muted-foreground hover:text-foreground mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回首页
          </Link>
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl md:text-5xl font-bold text-foreground">
              {article.title}
            </h1>
            {isAdmin && !isEditing && (
              <div className="flex items-center gap-2">
                <Link
                  to={`/admin/articles/${article.slug}/edit`}
                  className="flex items-center space-x-2 bg-primary/20 text-primary px-4 py-2 rounded-md hover:bg-primary/30 transition-colors"
                >
                  <Edit className="w-4 h-4" />
                  <span>进入编辑器</span>
                </Link>
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center space-x-2 bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-accent transition-colors"
                >
                  <Edit className="w-4 h-4" />
                  <span>快速编辑</span>
                </button>
              </div>
            )}
            {isAdmin && isEditing && (
              <div className="flex items-center space-x-2">
                <button 
                  onClick={handleSave}
                  className="flex items-center space-x-2 bg-green-500/20 text-green-500 px-4 py-2 rounded-md hover:bg-green-500/30 transition-colors"
                >
                  <Save className="w-4 h-4" />
                  <span>保存</span>
                </button>
                <button 
                  onClick={() => {
                    setIsEditing(false);
                    setEditedContent(article.content);
                  }}
                  className="flex items-center space-x-2 bg-red-500/20 text-red-500 px-4 py-2 rounded-md hover:bg-red-500/30 transition-colors"
                >
                  <X className="w-4 h-4" />
                  <span>取消</span>
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground">
            <div className="flex items-center">
              <Calendar className="w-4 h-4 mr-2" />
              {new Date(article.createdAt).toLocaleDateString('zh-CN')}
            </div>
            <div className="flex items-center">
              <Clock className="w-4 h-4 mr-2" />
              {article.readTime} 分钟阅读
            </div>
            <div className="flex items-center">
              <Tag className="w-4 h-4 mr-2" />
              {article.category}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-12">
        {isEditing ? (
          <div className="bg-card p-4 rounded-xl border border-border" data-color-mode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}>
            <MDEditor
              value={editedContent}
              onChange={(val) => setEditedContent(val || '')}
              previewOptions={{
                rehypePlugins: [[rehypeSanitize]],
              }}
              height={600}
              className="!bg-background"
            />
          </div>
        ) : (
          <article className="prose prose-neutral dark:prose-invert prose-blue max-w-none">
            <ReactMarkdown
              components={{
                code({ node, inline, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || '');
                  return !inline && match ? (
                    <SyntaxHighlighter
                      style={vscDarkPlus}
                      language={match[1]}
                      PreTag="div"
                      {...props}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {article.content}
            </ReactMarkdown>
          </article>
        )}

        {/* Footer Tags */}
        <div className="mt-12 pt-8 border-t border-border">
          <div className="flex flex-wrap gap-2">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 bg-secondary text-secondary-foreground text-xs rounded-full border border-border"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Comments Section */}
        <div className="mt-16">
          <h3 className="text-2xl font-bold mb-8 flex items-center">
            <MessageSquare className="w-6 h-6 mr-3 text-primary" />
            评论 ({comments.length})
          </h3>

          {user ? (
            <div className="mb-10 bg-card p-4 rounded-xl border border-border">
              <div className="flex items-start space-x-4">
                <img 
                  src={user.user_metadata?.avatar_url} 
                  alt="Avatar" 
                  className="w-10 h-10 rounded-full border border-border"
                />
                <div className="flex-1">
                  <textarea
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder="分享你的想法..."
                    className="w-full bg-background border border-border rounded-lg p-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary min-h-[100px] resize-y"
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={submitComment}
                      disabled={!newComment.trim()}
                      className="px-6 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      发表评论
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-10 bg-card/50 p-6 rounded-xl border border-border text-center">
              <p className="text-muted-foreground mb-4">登录后参与讨论</p>
              <button
                onClick={() => supabase.auth.signInWithOAuth({ provider: 'github' })}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:bg-primary/90 transition-colors"
              >
                使用 GitHub 登录
              </button>
            </div>
          )}

          {loadingComments ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {comments.map((comment) => (
                <div key={comment.id} className="bg-card p-5 rounded-xl border border-border flex space-x-4 group">
                  <img 
                    src={comment.avatar_url} 
                    alt={comment.user_name} 
                    className="w-10 h-10 rounded-full border border-border flex-shrink-0"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-semibold text-foreground mr-3">{comment.user_name}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(comment.created_at).toLocaleString('zh-CN')}
                        </span>
                      </div>
                      {(user?.id === comment.user_id || isAdmin) && (
                        <button
                          onClick={() => deleteComment(comment.id)}
                          className="text-red-500/50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title="删除评论"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))}
              
              {comments.length === 0 && (
                <div className="text-center py-10 text-muted-foreground">
                  暂无评论，快来抢沙发吧！
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default ArticleDetail;
