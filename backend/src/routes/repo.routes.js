// routes/repo.routes.js
import { Router } from 'express';
import * as c from '../controllers/repo.controller.js';
const r = Router();
r.get('/', c.list);
r.get('/:id', c.detail);
r.get('/:id/snapshots', c.snapshots);
r.patch('/:id', c.update);
r.delete('/:id', c.remove);
export default r;
