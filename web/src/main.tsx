import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/app.css';
import './pages/Landing/Landing.css';
import './pages/Analyzing/Analyzing.css';
import './pages/Main/Main.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
