import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '이음5G 특화망 AI 상담 | KCA',
  description: '5G 특화망(이음5G) 도입 절차, 주파수 할당, 구축 사례를 안내하는 한국방송통신전파진흥원(KCA) AI 상담',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1456fd',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
