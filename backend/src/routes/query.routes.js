// routes/query.routes.js
import { Router } from 'express';
import * as c from '../controllers/query.controller.js';
const r = Router();
r.get('/', c.list);
r.post('/', c.create);
r.patch('/:id', c.update);
r.delete('/:id', c.remove);
export default r;
