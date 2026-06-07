// routes/etl.routes.js
import { Router } from 'express';
import * as c from '../controllers/etl.controller.js';
const r = Router();
r.post('/run', c.run);
r.get('/status', c.status);
export default r;
