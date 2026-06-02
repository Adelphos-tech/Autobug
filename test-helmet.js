const express = require('express');
const helmet = require('helmet');

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      'font-src': ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      'img-src': ["'self'", "data:", "blob:", "https:"],
      'connect-src': ["'self'", "https://api.groq.com", "https://cdnjs.cloudflare.com"],
      'worker-src': ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
    },
  },
}));

app.get('/', (req, res) => res.send('OK'));

const server = app.listen(0, () => {
  const port = server.address().port;
  const http = require('http');
  http.get(`http://localhost:${port}/`, (res) => {
    console.log('CSP:', res.headers['content-security-policy']);
    server.close();
  });
});
