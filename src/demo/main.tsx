// The first import is the guard: it must run before any view can call fetch.
import './guard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../components/ui/Toast';
import '../index.css';
import { DemoApp } from './DemoApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <DemoApp />
    </ToastProvider>
  </StrictMode>,
);
