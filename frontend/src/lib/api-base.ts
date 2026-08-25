// Centralized API base URL
// In wallet browsers, relative paths like '/api' resolve to the wallet's domain → 404
// Always use absolute URL when VITE_API_BASE_URL is not set
// NOTE: includes /api prefix because app.ts mounts router at /api

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://zeus-insurance-bot-api-production.up.railway.app/api')
  .replace(/\/+$/, '');

export default API_BASE;
