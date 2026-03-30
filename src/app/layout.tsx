import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '이음5G 주파수 이용관리 - 오늘의 뉴스',
  description: 'AI가 선별한 5G 주파수 관련 주요 이슈',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
