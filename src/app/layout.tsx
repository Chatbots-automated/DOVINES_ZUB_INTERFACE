import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { FARM_NAME, PRODUCT_NAME } from "@/lib/brand";

const fontDisplay = Bricolage_Grotesque({
  variable: "--font-heading",
  subsets: ["latin", "latin-ext"],
  axes: ["wdth", "opsz"],
});

const fontBody = IBM_Plex_Sans({
  variable: "--font-body",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: `${FARM_NAME} | ${PRODUCT_NAME}`,
  description: `${FARM_NAME} veterinarinės veiklos valdymo sistema`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="lt" className={`${fontDisplay.variable} ${fontBody.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
