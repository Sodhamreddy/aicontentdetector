import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './app.css';

try { document.documentElement.dataset.theme = localStorage.getItem('kleza-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.dataset.theme = 'light'; }

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
