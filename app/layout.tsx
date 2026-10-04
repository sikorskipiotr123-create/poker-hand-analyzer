import type { Metadata } from 'next';
import './globals.css';
import { LanguageProvider } from './providers';
export const metadata: Metadata = { title: 'Analizator Pokera', description: 'Texas Hold’em poker hand, equity, pot odds, and EV analysis.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pl"><body><LanguageProvider>{children}</LanguageProvider></body></html>; }
