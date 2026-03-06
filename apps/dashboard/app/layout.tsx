import type { Metadata } from "next";

import "./globals.css";

const uiPerfMode = process.env.NEXT_PUBLIC_DASHBOARD_UI_PERF ?? "low";

export const metadata: Metadata = {
  title: "전술 관제 대시보드",
  description: "존 기반 AI 단타 시스템 관제 대시보드"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body data-ui-perf={uiPerfMode}>{children}</body>
    </html>
  );
}
