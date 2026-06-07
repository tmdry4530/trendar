import { Router } from 'express';
import * as c from '../controllers/repo.controller.js';

const r = Router();
r.get('/stats', c.stats);
r.get('/stats/languages', c.languages);
r.get('/trends', c.trends);
export default r;
