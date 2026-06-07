import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import queryRoutes from './routes/query.routes.js';
import repoRoutes from './routes/repo.routes.js';
import etlRoutes from './routes/etl.routes.js';
import statsRoutes from './routes/stats.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.use('/api/queries', queryRoutes);
app.use('/api/repos', repoRoutes);
app.use('/api/etl', etlRoutes);
app.use('/api', statsRoutes);

if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use(errorHandler);

export default app;
