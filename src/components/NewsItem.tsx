import type { NewsData } from '@/types';
import styles from './NewsItem.module.css';

interface Props {
  item: NewsData;
}

export default function NewsItem({ item }: Props) {
  const categoryClass = item.category === '기술'
    ? styles.categoryTech
    : item.category === '정책'
      ? styles.categoryPolicy
      : '';

  const keywords = item.keyword
    ? item.keyword.split(',').map(k => k.trim()).filter(Boolean)
    : [];

  return (
    <div className={styles.item} onClick={() => window.open(item.url || '#', '_blank')}>
      <span className={`${styles.category} ${categoryClass}`}>{item.category || '이슈'}</span>
      <div className={styles.title}>{item.title}</div>
      <div className={styles.meta}>{item.source} | {item.date}</div>
      <div className={styles.summary}>{item.summary}</div>
      {keywords.length > 0 && (
        <div className={styles.keywords}>
          {keywords.map((kw, i) => (
            <span key={i} className={styles.tag}>#{kw}</span>
          ))}
        </div>
      )}
    </div>
  );
}
